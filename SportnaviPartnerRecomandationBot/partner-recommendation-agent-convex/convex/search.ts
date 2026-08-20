/**
 * convex/search.ts — the port of the `match_partners` hybrid-search RPC.
 *
 * This is the only genuinely non-trivial translation in the migration, so the
 * original is reproduced here term by term. The SQL builds five CTEs and fuses
 * four of them with Reciprocal Rank Fusion:
 *
 *   qraw/qtags : expand the caller's tags through okf.tag_variants and
 *                public.tag_synonyms into a canonical slug set
 *   base/geo   : the candidate set — active partners with an embedding,
 *                optionally filtered to one city / postal prefix / radius
 *   vec        : top 40 by cosine distance          -> rnk, similarity
 *   kw         : top 40 by ts_rank(fts, q)          -> rnk, fts_rank
 *   nm         : top 40 by similarity(name, text)   -> rnk, name_sim   (> 0.25)
 *   tg         : top 40 by tag overlap count        -> rnk, tag_overlap (> 0)
 *
 *   rrf_score = Σ over present branches of 1 / (60 + rnk)
 *   order by rrf_score desc, id
 *   limit match_count
 *
 * ── HOW THE FOUR BRANCHES MAP ONTO CONVEX ────────────────────────────────────
 *
 * `vec` uses Convex's native vector index (`ctx.vectorSearch`), which is only
 * callable from an action — hence the action/internalQuery split below. Its
 * `_score` for a cosine index is the cosine similarity, which is exactly
 * Postgres' `1 - (embedding <=> query)`.
 *
 * `kw`, `nm` and `tg` are computed in TypeScript over the candidate set. That
 * is not a fallback, it is the faithful choice: all three CTEs are already
 * scoped to `geo`, i.e. ONE city's active partners (≤ ~100 rows in this
 * directory), and each needs semantics Convex's built-in search index does not
 * offer — German Snowball stemming with AND-of-terms matching, pg_trgm
 * trigram similarity, and tag-slug set overlap. Reimplementing them exactly
 * (convex/lib/germanFts.ts, convex/lib/trigram.ts) keeps retrieval behaviour
 * comparable; substituting Convex's fuzzy BM25 search index would have made
 * the Convex build silently better at the `kw` branch and destroyed the
 * apples-to-apples property this whole project exists to test.
 *
 * The lexemes those branches read are PRECOMPUTED at seed time into
 * `partnerSearchDocs` — the direct analogue of Postgres storing `fts` as a
 * GENERATED tsvector column rather than parsing text per query.
 *
 * ── DEVIATIONS (all listed in MIGRATION-NOTES.md) ────────────────────────────
 *  - `filters.near` (radius) and `filters.postal_prefix` are not implemented.
 *    No caller passes them; `distance_km` is therefore always null, which is
 *    what the Supabase caller already receives.
 *  - `filters.exclude_ids` is applied AFTER the vector search rather than
 *    inside `base`. No caller passes it either.
 *  - `ts_rank` is approximated (see convex/lib/germanFts.ts). Only the rank
 *    ORDER feeds RRF, and no application code reads `fts_rank`.
 *  - Ties inside a branch are broken by partner id ascending. Postgres'
 *    `row_number()` leaves ties unordered; this codebase requires determinism
 *    (CLAUDE.md §12.7).
 */

// NOTE: deliberately NOT a "use node" module. `ctx.vectorSearch` is available
// in the default Convex runtime, which has no Node cold-start cost — and this
// action sits on the measured latency path.

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { BRANCH_LIMIT } from "./lib/rrf";

// BRANCH_LIMIT is the `limit 40` the SQL hardcodes in each of vec/kw/nm/tg.
// CLAUDE.md §10.2 flags it as an open issue in the Supabase build — requesting
// k=120 can never return more than 40 vector-scored rows. It is reproduced
// rather than fixed, so the two builds retrieve the same thing.

/** The row shape `match_partners` returns. Declared as a TS type as well as a
 *  validator because the handler below calls an internalQuery, and Convex's
 *  generated API types would otherwise make the two mutually recursive
 *  (TS7022/TS7023) — an explicit handler return annotation breaks the cycle. */
export interface MatchPartnersRow {
  partner_id: number;
  title: string;
  city: string | null;
  tags: string[] | null;
  distance_km: number | null;
  similarity: number | null;
  fts_rank: number | null;
  name_sim: number | null;
  tag_overlap: number | null;
  rrf_score: number;
}

const matchRow = v.object({
  partner_id: v.number(),
  title: v.string(),
  city: v.union(v.string(), v.null()),
  tags: v.union(v.array(v.string()), v.null()),
  distance_km: v.union(v.number(), v.null()),
  similarity: v.union(v.number(), v.null()),
  fts_rank: v.union(v.number(), v.null()),
  name_sim: v.union(v.number(), v.null()),
  tag_overlap: v.union(v.number(), v.null()),
  rrf_score: v.number(),
});

/**
 * `match_partners(query_embedding, query_text, filters, match_count)`.
 *
 * An action because `ctx.vectorSearch` is action-only. It runs the vector
 * branch, then hands the ranked ids to `internal.searchRanking.fuse`, which
 * computes the three text branches and performs the fusion inside a single
 * transactional query.
 */
export const matchPartners = action({
  args: {
    /** null degrades to text-only, exactly as passing a NULL vector to the
     *  non-STRICT SQL function does: the `vec` CTE contributes nothing and the
     *  other branches still rank. Edge case E25. */
    queryEmbedding: v.union(v.array(v.float64()), v.null()),
    queryText: v.union(v.string(), v.null()),
    filters: v.object({
      city: v.optional(v.string()),
      excludeIds: v.optional(v.array(v.number())),
      tags: v.optional(v.array(v.string())),
    }),
    matchCount: v.number(),
  },
  returns: v.array(matchRow),
  handler: async (ctx, args): Promise<MatchPartnersRow[]> => {
    const cityLower = args.filters.city?.toLowerCase();

    // ── vec CTE ───────────────────────────────────────────────────────────
    // `partnerEmbeddings` only holds rows for active partners that have an
    // embedding, so the index itself encodes `base`'s
    // `is_active AND profile_embedding IS NOT NULL` predicate. Convex vector
    // filters support only eq/or (never and), which is precisely why that
    // predicate had to be baked into the table's population rule instead of
    // being a second filter field.
    let vec: Array<{ embeddingDocId: Id<"partnerEmbeddings">; similarity: number }> = [];
    if (args.queryEmbedding !== null) {
      const city = cityLower;
      const hits = await ctx.vectorSearch("partnerEmbeddings", "by_embedding", {
        vector: args.queryEmbedding,
        limit: BRANCH_LIMIT,
        ...(city !== undefined ? { filter: (q) => q.eq("cityLower", city) } : {}),
      });
      // Already ordered by descending cosine similarity — the same order the
      // SQL's `order by embedding <=> query` produces.
      vec = hits.map((h) => ({ embeddingDocId: h._id, similarity: h._score }));
    }

    return await ctx.runQuery(internal.searchRanking.fuse, {
      cityLower: cityLower ?? null,
      queryText: args.queryText,
      tags: args.filters.tags ?? [],
      excludeIds: args.filters.excludeIds ?? [],
      matchCount: args.matchCount,
      vec,
      // The vec CTE does NOT go away when the embedding is null - see the
      // degrade note in convex/searchRanking.ts. The fuse query needs to know
      // the difference between "no vector search was run" and "it returned
      // nothing".
      embeddingWasNull: args.queryEmbedding === null,
    });
  },
});
