/**
 * convex/partners.ts — the two non-search partner reads.
 *
 *   supabase.from("partners").select(...).in("city", aliases)
 *     + the manual partner_intelligence join   ->  partners.getPartnersByCity
 *   get_partner_profiles(p_ids)                ->  partners.getPartnerProfiles
 *
 * Both return the EXACT column names the Supabase versions returned, so
 * lib/partners/get-partners-by-city.ts and lib/partners/build-recommendations.ts
 * keep their row-mapping code unchanged. Identical shapes on both sides is
 * what makes the latency comparison a comparison of the backends rather than
 * of two different serialization budgets.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/** Bound on a single city's partner set. The largest city in the directory
 *  (Bielefeld) has ~100 active partners; 2,000 is generous headroom without
 *  being an unbounded read. */
const CITY_PARTNER_LIMIT = 2_000;

/** Bound on one batched profile hydration. `finalRecommendations` is clamped
 *  to `maxPartners` (100) by the tool, and the dev-console "all found" call
 *  asks for the whole resolved set. */
const PROFILE_BATCH_LIMIT = 500;

/**
 * Port of `getPartnersByCity`'s Supabase query pair.
 *
 * SELECTED COLUMNS — deliberately the same short list as SELECT_COLUMNS in
 * lib/partners/get-partners-by-city.ts:
 *   id, name, city, tags_norm, body_markdown, website_url, is_active, updated_at
 * NO email/phone: contact info reaches the model through exactly one route,
 * the pre-rendered `llm_profile` (CLAUDE.md §4.4/§12.4). Projecting here also
 * keeps `llm_profile` (up to 20 KB/partner) off this hot path in both builds.
 *
 * `quality_score` is joined from `partnerIntelligence` best-effort, matching
 * the Supabase code's second query — there is no foreign key between the two
 * tables in Postgres, so there is none here either.
 */
export const getPartnersByCity = query({
  args: {
    /** All matching city spellings from resolveCityFuzzy. Matched EXACTLY,
     *  the same as the Supabase `.in("city", aliases)`. */
    aliases: v.array(v.string()),
    /** Overlap filter on tags_norm; applied only when provided and non-empty. */
    tagFilter: v.optional(v.array(v.string())),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      id: v.number(),
      name: v.string(),
      city: v.union(v.string(), v.null()),
      tags_norm: v.union(v.array(v.string()), v.null()),
      body_markdown: v.union(v.string(), v.null()),
      website_url: v.union(v.string(), v.null()),
      is_active: v.boolean(),
      updated_at: v.union(v.string(), v.null()),
      quality_score: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.aliases.length === 0) return []; // no coverage (E2)

    const tagFilter =
      args.tagFilter && args.tagFilter.length > 0 ? new Set(args.tagFilter) : null;

    type Row = {
      id: number;
      name: string;
      city: string | null;
      tags_norm: string[] | null;
      body_markdown: string | null;
      website_url: string | null;
      is_active: boolean;
      updated_at: string | null;
      quality_score: number | null;
    };

    // One index scan per alias. `aliases` is at most a handful of spellings
    // (resolve_city_fuzzy returns a single canonical label today), so this is
    // the direct equivalent of the SQL `city = ANY(aliases)`.
    const byId = new Map<number, Row>();

    for (const alias of args.aliases) {
      const docs = await ctx.db
        .query("partners")
        .withIndex("by_city", (q) => q.eq("city", alias))
        .take(CITY_PARTNER_LIMIT);

      for (const d of docs) {
        if (!args.includeInactive && !d.isActive) continue;
        if (tagFilter && !d.tagsNorm.some((t) => tagFilter.has(t))) continue;
        // Dedup by id: aliases can overlap, or a partner can match twice.
        if (byId.has(d.sourceId)) continue;
        byId.set(d.sourceId, {
          id: d.sourceId,
          name: d.name,
          city: d.city,
          tags_norm: d.tagsNorm,
          body_markdown: d.bodyMarkdown,
          website_url: d.websiteUrl,
          is_active: d.isActive,
          updated_at: d.updatedAt,
          quality_score: null, // filled below
        });
      }
    }

    const rows: Row[] = [...byId.values()];
    if (rows.length === 0) return rows;

    // Best-effort manual join — quality_score is a nice-to-have that the
    // "quality" overflow strategy reads; never block the fetch on it.
    for (const row of rows) {
      const intel = await ctx.db
        .query("partnerIntelligence")
        .withIndex("by_partner_id", (q) => q.eq("partnerId", row.id))
        .unique();
      row.quality_score = intel?.qualityScore ?? null;
    }

    return rows;
  },
});

/**
 * Port of:
 *
 *   create function get_partner_profiles(p_ids bigint[])
 *   returns table(partner_id, title, city, street, postal_code, tags,
 *                 courses_text, body_markdown, email, phone, website_url,
 *                 llm_profile, profile_data)
 *   ... where p.id = any(p_ids) and p.is_active
 *
 * The full column list is returned even though callers read only four of them.
 * That is intentional: the Supabase client receives all thirteen over the
 * wire, and shrinking the payload here would hand Convex a transfer-size
 * advantage that has nothing to do with the database.
 *
 * `profile_data` is the one exception. It is a free-form jsonb blob that no
 * code in either implementation reads, so it is NOT migrated and this column
 * is always null. The key is kept so the response shape still typechecks
 * against the Supabase row type. This is the only intentional payload
 * difference between the two `get_partner_profiles` implementations, and it is
 * listed in MIGRATION-NOTES.md §"Known deviations".
 *
 * NOTE the history: this RPC carried a hardcoded `limit 10` in Postgres until
 * 2026-08-01, which silently starved the model of profiles (CLAUDE.md §10.8).
 * There is no such cap here, and `buildRecommendations` still warns on a short
 * return in both builds.
 */
export const getPartnerProfiles = query({
  args: { ids: v.array(v.number()) },
  returns: v.array(
    v.object({
      partner_id: v.number(),
      title: v.string(),
      city: v.union(v.string(), v.null()),
      street: v.union(v.string(), v.null()),
      postal_code: v.union(v.string(), v.null()),
      tags: v.union(v.array(v.string()), v.null()),
      courses_text: v.union(v.string(), v.null()),
      body_markdown: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
      phone: v.union(v.string(), v.null()),
      website_url: v.union(v.string(), v.null()),
      llm_profile: v.union(v.string(), v.null()),
      profile_data: v.any(),
    }),
  ),
  handler: async (ctx, args) => {
    const ids = args.ids.slice(0, PROFILE_BATCH_LIMIT);
    const out = [];

    for (const id of ids) {
      const p = await ctx.db
        .query("partners")
        .withIndex("by_source_id", (q) => q.eq("sourceId", id))
        .unique();
      if (!p || !p.isActive) continue; // `and p.is_active` — inactive is a miss

      out.push({
        partner_id: p.sourceId,
        title: p.name,
        city: p.city,
        street: p.street,
        postal_code: p.postalCode,
        tags: p.tagsNorm, // the RPC aliases `p.tags_norm as tags`
        courses_text: p.coursesText,
        body_markdown: p.bodyMarkdown,
        email: p.email,
        phone: p.phone,
        website_url: p.websiteUrl,
        llm_profile: p.llmProfile,
        profile_data: null,
      });
    }

    return out;
  },
});

/** Bound on one embeddings fetch — a whole-city relevance-scoring pass; the
 *  largest city has ~100 active partners. */
const EMBEDDING_BATCH_LIMIT = 500;

/**
 * R13 §4.1 — stored profile embeddings for client-side relevance scoring
 * (lib/partners/score-relevance.ts, shared verbatim with the Supabase build).
 * Point-reads on `partnerEmbeddings.by_source_id`; a missing row (inactive or
 * embedding-less partner) is simply absent from the result — the caller
 * treats absent as "unscored", never as 0.
 */
export const getPartnerEmbeddings = query({
  args: { ids: v.array(v.number()) },
  returns: v.array(
    v.object({
      id: v.number(),
      embedding: v.array(v.float64()),
    }),
  ),
  handler: async (ctx, args) => {
    const ids = args.ids.slice(0, EMBEDDING_BATCH_LIMIT);
    const out = [];
    for (const id of ids) {
      const row = await ctx.db
        .query("partnerEmbeddings")
        .withIndex("by_source_id", (q) => q.eq("sourceId", id))
        .unique();
      if (row) out.push({ id: row.sourceId, embedding: row.embedding });
    }
    return out;
  },
});
