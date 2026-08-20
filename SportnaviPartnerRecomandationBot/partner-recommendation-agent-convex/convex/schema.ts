/**
 * convex/schema.ts — the Convex port of the Supabase `public` schema.
 *
 * MAPPING FROM POSTGRES (see ../MIGRATION-NOTES.md for the full rationale):
 *
 *   public.partners            -> partners            (row data, no vector)
 *                              -> partnerSearchDocs   (lean ranking projection == the `fts` generated column)
 *                              -> partnerEmbeddings   (the pgvector column, in its own table + vector index)
 *   public.partner_intelligence-> partnerIntelligence
 *   public.tag_synonyms        -> tagSynonyms
 *   okf.tag_variants           -> tagVariants
 *   (derived in RPC)           -> citySpellings       (materializes resolve_city_fuzzy's GROUP BY p.city)
 *   (derived in RPC)           -> cityCentroids       (materializes the city_centroids() RPC)
 *   (n/a)                      -> migrations          (setup bookkeeping so seeding is idempotent + verifiable)
 *
 * WHY partners IS SPLIT ACROSS THREE TABLES
 *
 * Postgres could keep the 1536-dim vector, the generated tsvector and the
 * 20 KB `llm_profile` in one row because a query only pays for the columns it
 * SELECTs. Convex reads whole documents. The hot ranking path (match_partners'
 * kw/nm/tg CTEs) touches up to ~100 partners of one city per gap-fill city and
 * needs only name/tags/lexemes — pulling `llm_profile` + a 12 KB float array
 * along for the ride would dominate the latency we are trying to measure.
 * So the row is split by access pattern, which is the Convex-idiomatic
 * equivalent of Postgres column projection. `partners` itself is only read by
 * the home-city fetch and profile hydration, which genuinely want the text.
 *
 * `sourceId` is the original Postgres `partners.id` (bigint). It is the join
 * key across all partner tables and the id the agent, tools, prompt and
 * dev console already speak — keeping it means the two implementations return
 * literally the same partner ids, which is what makes the A/B comparison
 * meaningful.
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Weighted, German-stemmed lexemes — the port of `partners.fts` (tsvector).
 *  A = name, B = courses_text, C = coalesce(embedded_text, okf). Weight
 *  letters match Postgres' setweight() so ts_rank's default {0.1,0.2,0.4,1.0}
 *  weight vector applies unchanged. */
const lexemes = v.array(v.string());

export default defineSchema({
  /**
   * public.partners — everything a caller reads as row data. The vector and
   * the ranking lexemes live in their own tables (see the header).
   */
  partners: defineTable({
    /** public.partners.id (bigint). Stable across both implementations. */
    sourceId: v.number(),
    name: v.string(),
    city: v.union(v.string(), v.null()),
    /** lower(city) — match_partners filters `lower(p.city) = lower(?)`. */
    cityLower: v.string(),
    /** slugify_tag(city) — city_centroids groups on this; umlaut-insensitive. */
    citySlug: v.string(),
    street: v.union(v.string(), v.null()),
    postalCode: v.union(v.string(), v.null()),
    latitude: v.union(v.number(), v.null()),
    longitude: v.union(v.number(), v.null()),
    tags: v.array(v.string()),
    tagsNorm: v.array(v.string()),
    bodyMarkdown: v.union(v.string(), v.null()),
    coursesText: v.union(v.string(), v.null()),
    llmProfile: v.union(v.string(), v.null()),
    /** Public directory contact info — see CLAUDE.md §4.4. Reaches the model
     *  ONLY inside llmProfile, exactly as in the Supabase implementation. */
    email: v.union(v.string(), v.null()),
    phone: v.union(v.string(), v.null()),
    websiteUrl: v.union(v.string(), v.null()),
    isActive: v.boolean(),
    /** ISO-8601 string, as PostgREST returned it (overflowStrategy "recency"). */
    updatedAt: v.union(v.string(), v.null()),
    embeddingModel: v.union(v.string(), v.null()),
  })
    .index("by_source_id", ["sourceId"])
    // getPartnersByCity matches the EXACT spelling resolve_city_fuzzy returned,
    // the same as the Supabase `.in("city", aliases)` — hence `city`, not slug.
    .index("by_city", ["city"])
    .index("by_city_lower", ["cityLower"])
    .index("by_city_slug", ["citySlug"]),

  /**
   * The port of the `partners.fts` GENERATED tsvector column, plus the two
   * other fields match_partners' non-vector CTEs read (`name` for the nm
   * trigram branch, `tags_norm` for the tg overlap branch).
   *
   * Rows exist ONLY for partners matching match_partners' `base` CTE
   * predicate: `is_active AND profile_embedding IS NOT NULL`. That makes a
   * simple index scan on this table exactly the candidate set the RPC's `geo`
   * CTE produces (minus the unused `near`/`postal_prefix` filters).
   */
  partnerSearchDocs: defineTable({
    sourceId: v.number(),
    name: v.string(),
    cityLower: v.string(),
    citySlug: v.string(),
    /** partners.tags (RAW). match_partners' result set exposes `p.tags`, not
     *  `p.tags_norm` — see the DEVIATIONS header in
     *  lib/partners/similarity-search-partners.ts. Carried so the Convex RPC
     *  returns the identical column. */
    tags: v.array(v.string()),
    /** partners.tags_norm — what the `tg` overlap CTE actually counts against. */
    tagsNorm: v.array(v.string()),
    postalCode: v.union(v.string(), v.null()),
    /** setweight(to_tsvector('german', name), 'A') */
    lexA: lexemes,
    /** setweight(to_tsvector('german', courses_text), 'B') */
    lexB: lexemes,
    /** setweight(to_tsvector('german', coalesce(embedded_text, okf)), 'C') */
    lexC: lexemes,
  })
    .index("by_source_id", ["sourceId"])
    .index("by_city_lower", ["cityLower"]),

  /**
   * The pgvector column. Its own table so that a 12 KB float array is never
   * pulled into a read that only wanted a name.
   *
   * A row exists only when the partner is ACTIVE and has an embedding — the
   * same predicate as partnerSearchDocs — which is why the vector index needs
   * no `isActive` filter field. That matters: Convex vector-search filters
   * support only `eq` and `or`, never `and`, so a second filter dimension
   * would not have been expressible anyway.
   */
  partnerEmbeddings: defineTable({
    sourceId: v.number(),
    cityLower: v.string(),
    embedding: v.array(v.float64()),
    embeddingModel: v.union(v.string(), v.null()),
  })
    .index("by_source_id", ["sourceId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536, // text-embedding-3-small — pinned, see lib/embeddings.ts
      filterFields: ["cityLower"],
    }),

  /**
   * public.partner_intelligence. Postgres has NO foreign key between this and
   * `partners` (CLAUDE.md §6), and the Supabase code joins it manually in a
   * second query. Reproduced faithfully: `partnerId` is a plain number keyed
   * to partners.sourceId, not a v.id("partners"), and the join stays manual.
   */
  partnerIntelligence: defineTable({
    partnerId: v.number(),
    qualityScore: v.union(v.number(), v.null()),
    contentQuality: v.union(v.number(), v.null()),
    courseQuality: v.union(v.number(), v.null()),
    tagQuality: v.union(v.number(), v.null()),
    contactQuality: v.union(v.number(), v.null()),
    locationQuality: v.union(v.number(), v.null()),
    isScrapeFailure: v.boolean(),
    category: v.union(v.string(), v.null()),
  }).index("by_partner_id", ["partnerId"]),

  /** public.tag_synonyms — read by match_partners' `qtags` CTE. */
  tagSynonyms: defineTable({
    variantSlug: v.string(),
    canonicalSlug: v.string(),
  }).index("by_variant_slug", ["variantSlug"]),

  /** okf.tag_variants — read by match_partners' `qraw` CTE (lower(variant)). */
  tagVariants: defineTable({
    variantLower: v.string(),
    tagSlug: v.string(),
  }).index("by_variant_lower", ["variantLower"]),

  /**
   * Materializes resolve_city_fuzzy's `GROUP BY p.city` aggregate: one row per
   * EXACT active city spelling that has coordinates, with the MEDIAN lat/lon
   * (percentile_cont(0.5)) the RPC computes.
   *
   * Convex has no SQL aggregation, so the group-by is precomputed at seed time
   * by convex/migrations.ts:rebuildCityAggregates. Cheap and correct: the
   * directory changes daily at most, and rebuild is one command. 648 rows.
   */
  citySpellings: defineTable({
    city: v.string(),
    citySlug: v.string(),
    medianLat: v.number(),
    medianLon: v.number(),
    partnerCount: v.number(),
  })
    .index("by_city", ["city"])
    .index("by_city_slug", ["citySlug"]),

  /**
   * Materializes the city_centroids() RPC: one row per city SLUG, AVG lat/lon,
   * active-with-coords count, display label = the most frequent spelling.
   * Note this is a DIFFERENT aggregate from citySpellings (slug vs exact
   * spelling, avg vs median) — Postgres has both, so Convex has both.
   */
  cityCentroids: defineTable({
    citySlug: v.string(),
    /** (array_agg(city order by spelling_count desc, city))[1] */
    city: v.string(),
    lat: v.number(),
    lon: v.number(),
    cnt: v.number(),
  }).index("by_city_slug", ["citySlug"]),

  /**
   * Backs `npm run generate:coverage`, which bakes the 40 largest cities into
   * agent/instructions/002-city-coverage.md. One row per distinct TRIMMED
   * active city spelling, with its total partner count.
   *
   * Deliberately NOT the same aggregate as `citySpellings`: that one requires
   * coordinates (resolve_city_fuzzy's `latitude is not null` predicate) and so
   * omits the handful of partners that lack geocoding. The coverage list in
   * the prompt must count every partner the directory actually has, or Navio
   * under-reports a city it does cover.
   */
  cityCoverage: defineTable({
    /** trim(city), raw spelling. The script applies Postgres' initcap() and
     *  regroups, exactly as the original SQL's `group by initcap(trim(city))`. */
    city: v.string(),
    count: v.number(),
  }).index("by_city", ["city"]),

  /**
   * Setup bookkeeping. There is no `supabase db push` equivalent for data, so
   * this is how `npm run convex:verify` can prove a clean environment was
   * fully provisioned rather than half-seeded.
   */
  migrations: defineTable({
    name: v.string(),
    appliedAt: v.number(),
    detail: v.string(),
  }).index("by_name", ["name"]),
});
