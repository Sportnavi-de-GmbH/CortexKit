/**
 * convex/migrations.ts — everything needed to bring a CLEAN Convex deployment
 * to a state where the agent works.
 *
 * Postgres had `supabase db push` for structure and a pre-populated table for
 * data. Convex pushes structure automatically from schema.ts, so "migration"
 * here means the data steps, and they are all functions rather than ad-hoc
 * script logic so they can be re-run, audited, and verified:
 *
 *   1. clearAll                 — reset a deployment to empty (idempotent reseed)
 *   2. upsert*Batch             — load partners / intelligence / embeddings /
 *                                 tag synonyms / tag variants
 *   3. rebuildCityAggregates    — materialize the two GROUP BY aggregates that
 *                                 resolve_city_fuzzy and city_centroids() used
 *                                 to compute in SQL
 *   4. recordMigration          — write the bookkeeping row
 *   5. verifySetup              — prove the deployment is complete, not
 *                                 half-seeded
 *
 * Every upsert is keyed on `sourceId` / the natural key, so running the seed
 * twice converges instead of duplicating. See ../SETUP.md for the runbook.
 */

import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { slugifyTag } from "./lib/slugify";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Reset
// ─────────────────────────────────────────────────────────────────────────────

const CLEARABLE = [
  "partners",
  "partnerSearchDocs",
  "partnerEmbeddings",
  "partnerIntelligence",
  "tagSynonyms",
  "tagVariants",
  "citySpellings",
  "cityCentroids",
  "cityCoverage",
  "migrations",
] as const;

/** One page of deletions. Called in a loop by `clearAll` so a 2,300-row table
 *  never has to fit in one transaction's write budget. */
export const clearTablePage = internalMutation({
  args: { table: v.string(), batchSize: v.number() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const table = args.table as (typeof CLEARABLE)[number];
    const docs = await ctx.db.query(table).take(args.batchSize);
    for (const d of docs) await ctx.db.delete(d._id);
    return { deleted: docs.length };
  },
});

/**
 * Empty every table. Guarded by an explicit confirmation string rather than a
 * boolean so it cannot be triggered by a stray `{}` argument.
 */
export const clearAll = action({
  args: { confirm: v.string() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    if (args.confirm !== "DELETE-ALL") {
      throw new Error('clearAll: pass { confirm: "DELETE-ALL" } to proceed.');
    }
    let total = 0;
    for (const table of CLEARABLE) {
      for (;;) {
        const { deleted } = await ctx.runMutation(internal.migrations.clearTablePage, {
          table,
          batchSize: 500,
        });
        total += deleted;
        if (deleted === 0) break;
      }
    }
    return { deleted: total };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Data load
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One partner, in the shape the export script emits. `citySlug` / `cityLower`
 * and the FTS lexemes are derived HERE rather than trusted from the payload —
 * so the same slugify/stemmer code that queries the data also produced it.
 */
const partnerInput = v.object({
  sourceId: v.number(),
  name: v.string(),
  city: v.union(v.string(), v.null()),
  street: v.union(v.string(), v.null()),
  postalCode: v.union(v.string(), v.null()),
  latitude: v.union(v.number(), v.null()),
  longitude: v.union(v.number(), v.null()),
  tags: v.array(v.string()),
  tagsNorm: v.array(v.string()),
  bodyMarkdown: v.union(v.string(), v.null()),
  coursesText: v.union(v.string(), v.null()),
  llmProfile: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  websiteUrl: v.union(v.string(), v.null()),
  isActive: v.boolean(),
  updatedAt: v.union(v.string(), v.null()),
  embeddingModel: v.union(v.string(), v.null()),
  /** Precomputed German lexemes for the three tsvector weight sections. The
   *  seed script computes them with convex/lib/germanFts.ts — the identical
   *  module the query path uses — so the two can never drift. */
  lexA: v.array(v.string()),
  lexB: v.array(v.string()),
  lexC: v.array(v.string()),
  /** True when the source row had a non-null profile_embedding. Together with
   *  isActive this decides whether a partnerSearchDocs row exists, mirroring
   *  match_partners' `base` CTE predicate. */
  hasEmbedding: v.boolean(),
});

export const upsertPartnersBatch = mutation({
  args: { rows: v.array(partnerInput) },
  returns: v.object({ inserted: v.number(), updated: v.number(), searchDocs: v.number() }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    let searchDocs = 0;

    for (const r of args.rows) {
      const cityLower = (r.city ?? "").toLowerCase();
      const citySlug = slugifyTag(r.city);

      const doc = {
        sourceId: r.sourceId,
        name: r.name,
        city: r.city,
        cityLower,
        citySlug,
        street: r.street,
        postalCode: r.postalCode,
        latitude: r.latitude,
        longitude: r.longitude,
        tags: r.tags,
        tagsNorm: r.tagsNorm,
        bodyMarkdown: r.bodyMarkdown,
        coursesText: r.coursesText,
        llmProfile: r.llmProfile,
        email: r.email,
        phone: r.phone,
        websiteUrl: r.websiteUrl,
        isActive: r.isActive,
        updatedAt: r.updatedAt,
        embeddingModel: r.embeddingModel,
      };

      const existing = await ctx.db
        .query("partners")
        .withIndex("by_source_id", (q) => q.eq("sourceId", r.sourceId))
        .unique();

      if (existing) {
        await ctx.db.replace(existing._id, doc);
        updated++;
      } else {
        await ctx.db.insert("partners", doc);
        inserted++;
      }

      // The lean ranking projection == match_partners' `base` CTE predicate.
      const eligible = r.isActive && r.hasEmbedding;
      const existingSearchDoc = await ctx.db
        .query("partnerSearchDocs")
        .withIndex("by_source_id", (q) => q.eq("sourceId", r.sourceId))
        .unique();

      if (!eligible) {
        if (existingSearchDoc) await ctx.db.delete(existingSearchDoc._id);
        continue;
      }

      const searchDoc = {
        sourceId: r.sourceId,
        name: r.name,
        cityLower,
        citySlug,
        tags: r.tags,
        tagsNorm: r.tagsNorm,
        postalCode: r.postalCode,
        lexA: r.lexA,
        lexB: r.lexB,
        lexC: r.lexC,
      };
      if (existingSearchDoc) await ctx.db.replace(existingSearchDoc._id, searchDoc);
      else await ctx.db.insert("partnerSearchDocs", searchDoc);
      searchDocs++;
    }

    return { inserted, updated, searchDocs };
  },
});

export const upsertEmbeddingsBatch = mutation({
  args: {
    rows: v.array(
      v.object({
        sourceId: v.number(),
        cityLower: v.string(),
        embedding: v.array(v.float64()),
        embeddingModel: v.union(v.string(), v.null()),
        /** Only ACTIVE partners get a vector row — the index encodes
         *  match_partners' `is_active` predicate (see schema.ts). */
        isActive: v.boolean(),
      }),
    ),
  },
  returns: v.object({ written: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    let written = 0;
    let skipped = 0;

    for (const r of args.rows) {
      const existing = await ctx.db
        .query("partnerEmbeddings")
        .withIndex("by_source_id", (q) => q.eq("sourceId", r.sourceId))
        .unique();

      if (!r.isActive) {
        if (existing) await ctx.db.delete(existing._id);
        skipped++;
        continue;
      }

      const doc = {
        sourceId: r.sourceId,
        cityLower: r.cityLower,
        embedding: r.embedding,
        embeddingModel: r.embeddingModel,
      };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("partnerEmbeddings", doc);
      written++;
    }

    return { written, skipped };
  },
});

export const upsertIntelligenceBatch = mutation({
  args: {
    rows: v.array(
      v.object({
        partnerId: v.number(),
        qualityScore: v.union(v.number(), v.null()),
        contentQuality: v.union(v.number(), v.null()),
        courseQuality: v.union(v.number(), v.null()),
        tagQuality: v.union(v.number(), v.null()),
        contactQuality: v.union(v.number(), v.null()),
        locationQuality: v.union(v.number(), v.null()),
        isScrapeFailure: v.boolean(),
        category: v.union(v.string(), v.null()),
      }),
    ),
  },
  returns: v.object({ written: v.number() }),
  handler: async (ctx, args) => {
    for (const r of args.rows) {
      const existing = await ctx.db
        .query("partnerIntelligence")
        .withIndex("by_partner_id", (q) => q.eq("partnerId", r.partnerId))
        .unique();
      if (existing) await ctx.db.replace(existing._id, r);
      else await ctx.db.insert("partnerIntelligence", r);
    }
    return { written: args.rows.length };
  },
});

export const upsertTagsBatch = mutation({
  args: {
    synonyms: v.array(v.object({ variantSlug: v.string(), canonicalSlug: v.string() })),
    variants: v.array(v.object({ variantLower: v.string(), tagSlug: v.string() })),
  },
  returns: v.object({ synonyms: v.number(), variants: v.number() }),
  handler: async (ctx, args) => {
    for (const s of args.synonyms) {
      const existing = await ctx.db
        .query("tagSynonyms")
        .withIndex("by_variant_slug", (q) => q.eq("variantSlug", s.variantSlug))
        .filter((q) => q.eq(q.field("canonicalSlug"), s.canonicalSlug))
        .unique();
      if (!existing) await ctx.db.insert("tagSynonyms", s);
    }
    for (const t of args.variants) {
      const existing = await ctx.db
        .query("tagVariants")
        .withIndex("by_variant_lower", (q) => q.eq("variantLower", t.variantLower))
        .filter((q) => q.eq(q.field("tagSlug"), t.tagSlug))
        .unique();
      if (!existing) await ctx.db.insert("tagVariants", t);
    }
    return { synonyms: args.synonyms.length, variants: args.variants.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Aggregates — the SQL GROUP BYs, materialized
// ─────────────────────────────────────────────────────────────────────────────

/** One page of the geo projection. Lean on purpose: this scans the whole
 *  table, so it must not drag `llm_profile` along.
 *
 *  `geocoded` distinguishes the two row predicates the three aggregates need:
 *   - citySpellings / cityCentroids want `is_active AND city IS NOT NULL AND
 *     latitude IS NOT NULL AND longitude IS NOT NULL` (geocoded === true)
 *   - cityCoverage wants `is_active AND trim(city) <> ''` regardless of coords
 */
export const listGeoPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        city: v.string(),
        citySlug: v.string(),
        latitude: v.union(v.number(), v.null()),
        longitude: v.union(v.number(), v.null()),
        geocoded: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db.query("partners").paginate(args.paginationOpts);
    return {
      page: result.page
        .filter((p) => p.isActive && p.city !== null && p.city.trim() !== "")
        .map((p) => ({
          city: p.city as string,
          citySlug: p.citySlug,
          latitude: p.latitude,
          longitude: p.longitude,
          geocoded: p.latitude !== null && p.longitude !== null,
        })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const writeCityAggregates = internalMutation({
  args: {
    spellings: v.array(
      v.object({
        city: v.string(),
        citySlug: v.string(),
        medianLat: v.number(),
        medianLon: v.number(),
        partnerCount: v.number(),
      }),
    ),
    centroids: v.array(
      v.object({
        citySlug: v.string(),
        city: v.string(),
        lat: v.number(),
        lon: v.number(),
        cnt: v.number(),
      }),
    ),
    coverage: v.array(v.object({ city: v.string(), count: v.number() })),
  },
  returns: v.object({
    spellings: v.number(),
    centroids: v.number(),
    coverage: v.number(),
  }),
  handler: async (ctx, args) => {
    // Full replace: a stale city row is worse than a missing one, because
    // find-nearby-cities would keep borrowing from a city that no longer has
    // partners. These tables are small (~650 rows), so this is cheap.
    for (const old of await ctx.db.query("citySpellings").take(10_000)) {
      await ctx.db.delete(old._id);
    }
    for (const old of await ctx.db.query("cityCentroids").take(10_000)) {
      await ctx.db.delete(old._id);
    }
    for (const old of await ctx.db.query("cityCoverage").take(10_000)) {
      await ctx.db.delete(old._id);
    }
    for (const s of args.spellings) await ctx.db.insert("citySpellings", s);
    for (const c of args.centroids) await ctx.db.insert("cityCentroids", c);
    for (const c of args.coverage) await ctx.db.insert("cityCoverage", c);
    return {
      spellings: args.spellings.length,
      centroids: args.centroids.length,
      coverage: args.coverage.length,
    };
  },
});

/** `percentile_cont(0.5) within group (order by x)` — the CONTINUOUS median
 *  Postgres computes, which interpolates between the two middle values for an
 *  even-sized group rather than picking one. */
function percentileCont(sorted: number[], p = 0.5): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * Rebuild `citySpellings` and `cityCentroids` from the current `partners`
 * table. Run after every seed and after any partner import — the Convex
 * counterpart of `npm run generate:coverage`'s "restart after data changes"
 * step, and the reason no query ever has to scan 2,300 partners.
 */
export const rebuildCityAggregates = action({
  args: {},
  returns: v.object({
    spellings: v.number(),
    centroids: v.number(),
    coverage: v.number(),
    partnersScanned: v.number(),
  }),
  // Explicit return annotation: this action calls internal mutations/queries
  // through the generated API, which makes the inferred type self-referential
  // (TS7022/TS7023). Annotating breaks the cycle.
  handler: async (
    ctx,
  ): Promise<{
    spellings: number;
    centroids: number;
    coverage: number;
    partnersScanned: number;
  }> => {
    // Three GROUP BYs in one pass: by exact spelling (resolve_city_fuzzy), by
    // slug (city_centroids), and by trimmed spelling (the coverage list).
    const bySpelling = new Map<string, { slug: string; lats: number[]; lons: number[] }>();
    const bySlug = new Map<
      string,
      { latSum: number; lonSum: number; cnt: number; spellings: Map<string, number> }
    >();
    const byTrimmed = new Map<string, number>();

    let cursor: string | null = null;
    let scanned = 0;

    for (;;) {
      const page: {
        page: Array<{
          city: string;
          citySlug: string;
          latitude: number | null;
          longitude: number | null;
          geocoded: boolean;
        }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.migrations.listGeoPage, {
        paginationOpts: { numItems: 500, cursor },
      });

      for (const row of page.page) {
        scanned++;

        const trimmed = row.city.trim();
        byTrimmed.set(trimmed, (byTrimmed.get(trimmed) ?? 0) + 1);

        // The two geo aggregates skip partners without coordinates, exactly
        // as the SQL predicates did.
        if (!row.geocoded) continue;
        const lat = row.latitude as number;
        const lon = row.longitude as number;

        const spelling = bySpelling.get(row.city) ?? {
          slug: row.citySlug,
          lats: [],
          lons: [],
        };
        spelling.lats.push(lat);
        spelling.lons.push(lon);
        bySpelling.set(row.city, spelling);

        const slug = bySlug.get(row.citySlug) ?? {
          latSum: 0,
          lonSum: 0,
          cnt: 0,
          spellings: new Map<string, number>(),
        };
        slug.latSum += lat;
        slug.lonSum += lon;
        slug.cnt += 1;
        slug.spellings.set(row.city, (slug.spellings.get(row.city) ?? 0) + 1);
        bySlug.set(row.citySlug, slug);
      }

      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const spellings = [...bySpelling.entries()].map(([city, g]) => ({
      city,
      citySlug: g.slug,
      medianLat: percentileCont([...g.lats].sort((a, b) => a - b)),
      medianLon: percentileCont([...g.lons].sort((a, b) => a - b)),
      partnerCount: g.lats.length,
    }));

    const centroids = [...bySlug.entries()].map(([citySlug, g]) => ({
      citySlug,
      // (array_agg(city order by spelling_count desc, city))[1]
      city: [...g.spellings.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]![0],
      lat: g.latSum / g.cnt,
      lon: g.lonSum / g.cnt,
      cnt: g.cnt,
    }));

    const coverage = [...byTrimmed.entries()].map(([city, count]) => ({ city, count }));

    const written: { spellings: number; centroids: number; coverage: number } =
      await ctx.runMutation(internal.migrations.writeCityAggregates, {
        spellings,
        centroids,
        coverage,
      });

    return { ...written, partnersScanned: scanned };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4/5. Bookkeeping and verification
// ─────────────────────────────────────────────────────────────────────────────

export const recordMigration = mutation({
  args: { name: v.string(), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("migrations")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    const doc = { name: args.name, detail: args.detail, appliedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("migrations", doc);
    return null;
  },
});

/** Mirrors `SetupCounts` in lib/convex-admin.ts. Declared as a TS type as well
 *  as a validator because `verifySetup` is an action that calls internal
 *  queries through the generated API — without an explicit handler return
 *  annotation TypeScript infers a cycle (TS7022/TS7023). */
interface SetupCounts {
  partners: number;
  activePartners: number;
  partnerSearchDocs: number;
  partnerEmbeddings: number;
  partnerIntelligence: number;
  tagSynonyms: number;
  tagVariants: number;
  citySpellings: number;
  cityCentroids: number;
  cityCoverage: number;
}

/** Page sizes for counting, chosen by DOCUMENT SIZE rather than row count.
 *  A Convex function may read at most 16 MB per execution, and these documents
 *  are not small: a partner carries `llm_profile` (avg 1.6 KB, max 20 KB) and
 *  an embedding row is 1536 float64s (~12 KB). Counting 2,333 partners in one
 *  transaction exceeds the limit outright. */
const COUNT_PAGE_SIZE: Record<string, number> = {
  partners: 150,
  partnerEmbeddings: 100,
  partnerSearchDocs: 200,
};
const DEFAULT_COUNT_PAGE_SIZE = 1_000;

/**
 * Counts one page of a table. `activeMatches` is only meaningful for
 * `partners`; it saves a second full pass just to count active rows.
 */
export const countTablePage = internalQuery({
  args: { table: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.object({
    count: v.number(),
    activeCount: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const table = args.table as (typeof CLEARABLE)[number];
    const result = await ctx.db.query(table).paginate(args.paginationOpts);
    return {
      count: result.page.length,
      activeCount: result.page.filter(
        (d) => (d as { isActive?: boolean }).isActive === true,
      ).length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Row counts per table plus the applied-migration log.
 *
 * This exists because of CLAUDE.md §9's lesson: pair every health signal with
 * a work-actually-performed signal. A half-seeded deployment answers requests
 * happily and returns a shorter shortlist, which is indistinguishable from
 * "this city really is thin" unless you can see the counts.
 *
 * An ACTION rather than a query because counting means reading, and reading
 * 2,333 partner documents in one transaction blows past Convex's 16 MB
 * per-execution read limit. Paginating spreads the read across transactions.
 * Never on the request path — only the verify script and the smoke test call
 * it. If the directory grows an order of magnitude, swap in
 * @convex-dev/aggregate, which maintains counts incrementally.
 */
export const verifySetup = action({
  args: {},
  returns: v.object({
    counts: v.object({
      partners: v.number(),
      activePartners: v.number(),
      partnerSearchDocs: v.number(),
      partnerEmbeddings: v.number(),
      partnerIntelligence: v.number(),
      tagSynonyms: v.number(),
      tagVariants: v.number(),
      citySpellings: v.number(),
      cityCentroids: v.number(),
      cityCoverage: v.number(),
    }),
    migrations: v.array(
      v.object({ name: v.string(), appliedAt: v.number(), detail: v.string() }),
    ),
  }),
  handler: async (
    ctx,
  ): Promise<{
    counts: SetupCounts;
    migrations: Array<{ name: string; appliedAt: number; detail: string }>;
  }> => {
    const countTable = async (table: string): Promise<{ total: number; active: number }> => {
      const numItems = COUNT_PAGE_SIZE[table] ?? DEFAULT_COUNT_PAGE_SIZE;
      let cursor: string | null = null;
      let total = 0;
      let active = 0;
      for (;;) {
        const page: {
          count: number;
          activeCount: number;
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.migrations.countTablePage, {
          table,
          paginationOpts: { numItems, cursor },
        });
        total += page.count;
        active += page.activeCount;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      return { total, active };
    };

    const partners = await countTable("partners");

    return {
      counts: {
        partners: partners.total,
        activePartners: partners.active,
        partnerSearchDocs: (await countTable("partnerSearchDocs")).total,
        partnerEmbeddings: (await countTable("partnerEmbeddings")).total,
        partnerIntelligence: (await countTable("partnerIntelligence")).total,
        tagSynonyms: (await countTable("tagSynonyms")).total,
        tagVariants: (await countTable("tagVariants")).total,
        citySpellings: (await countTable("citySpellings")).total,
        cityCentroids: (await countTable("cityCentroids")).total,
        cityCoverage: (await countTable("cityCoverage")).total,
      },
      migrations: await ctx.runQuery(internal.migrations.listMigrations, {}),
    };
  },
});

export const listMigrations = internalQuery({
  args: {},
  returns: v.array(
    v.object({ name: v.string(), appliedAt: v.number(), detail: v.string() }),
  ),
  handler: async (ctx) => {
    return (await ctx.db.query("migrations").take(200)).map((m) => ({
      name: m.name,
      appliedAt: m.appliedAt,
      detail: m.detail,
    }));
  },
});
