/**
 * convex/searchRanking.ts — the transactional half of `match_partners`.
 *
 * convex/search.ts runs the `vec` CTE (vector index, action-only) and hands
 * the result here. This query reproduces `qraw`/`qtags`, the `kw`/`nm`/`tg`
 * CTEs, the full-outer-join and the RRF fusion, all inside one Convex query so
 * every branch sees a single consistent snapshot — the same guarantee the
 * single SQL statement gives.
 *
 * Read the header of convex/search.ts first; the SQL is quoted there.
 */

import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { slugifyTag } from "./lib/slugify";
import { trigramSimilarity } from "./lib/trigram";
import {
  matchesTsQuery,
  toTsVector,
  tsRank,
  websearchToTsQuery,
  type TsVector,
} from "./lib/germanFts";
import {
  BRANCH_LIMIT,
  compareByRrf,
  fusedIds,
  rankBranch,
  rrfContribution,
  type BranchHit,
} from "./lib/rrf";

/** Matches convex/partners.ts:CITY_PARTNER_LIMIT — the `geo` CTE for one city. */
const CANDIDATE_LIMIT = 2_000;

/** The `nm` CTE's floor: `similarity(g.name, query_text) > 0.25`. */
const NAME_SIM_FLOOR = 0.25;

interface Candidate {
  sourceId: number;
  name: string;
  city: string | null;
  tags: string[];
  tagsNorm: string[];
  vec: TsVector;
}

/**
 * `qraw` + `qtags`:
 *
 *   qraw:  for each tag x, slug = coalesce(okf.tag_variants[lower(x)], slugify_tag(x)),
 *          skipping x whose slug is empty
 *   qtags: qraw.slug  UNION  tag_synonyms.canonical_slug where variant_slug = qraw.slug
 *
 * Returns the canonical slug set the `tg` CTE counts overlap against. Empty
 * set => the `tg` branch does not fire at all (the SQL guards it with
 * `cardinality(qtags.slugs) > 0`) — which is exactly the bug CLAUDE.md §10.10
 * describes when `filters.tags` was never being passed.
 */
async function expandTags(
  ctx: { db: any },
  tags: readonly string[],
): Promise<Set<string>> {
  const raw = new Set<string>();

  for (const x of tags) {
    const slug = slugifyTag(x);
    if (slug === "") continue; // `where slugify_tag(x) <> ''`

    // LEFT JOIN okf.tag_variants ON lower(variant) = lower(x). A variant can
    // map to several tag_slugs; the SQL's `select distinct` keeps them all.
    const variants = await ctx.db
      .query("tagVariants")
      .withIndex("by_variant_lower", (q: any) => q.eq("variantLower", x.toLowerCase()))
      .take(64);

    if (variants.length > 0) {
      for (const vRow of variants) raw.add(vRow.tagSlug);
    } else {
      raw.add(slug); // coalesce(...) fallback
    }
  }

  const out = new Set<string>(raw);
  for (const slug of raw) {
    const synonyms = await ctx.db
      .query("tagSynonyms")
      .withIndex("by_variant_slug", (q: any) => q.eq("variantSlug", slug))
      .take(64);
    for (const s of synonyms) out.add(s.canonicalSlug);
  }
  return out;
}

export const fuse = internalQuery({
  args: {
    cityLower: v.union(v.string(), v.null()),
    queryText: v.union(v.string(), v.null()),
    tags: v.array(v.string()),
    excludeIds: v.array(v.number()),
    matchCount: v.number(),
    vec: v.array(
      v.object({
        embeddingDocId: v.id("partnerEmbeddings"),
        similarity: v.number(),
      }),
    ),
    /** True when the caller passed `query_embedding: null` (the E25 degrade). */
    embeddingWasNull: v.boolean(),
  },
  returns: v.array(
    v.object({
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
    }),
  ),
  handler: async (ctx, args) => {
    const excluded = new Set(args.excludeIds);

    // ── base / geo ────────────────────────────────────────────────────────
    // partnerSearchDocs contains exactly the rows matching the SQL's
    // `is_active AND profile_embedding IS NOT NULL`, so an index scan on
    // cityLower IS the `geo` CTE. `near` and `postal_prefix` are unimplemented
    // (no caller uses them) — see the DEVIATIONS list in convex/search.ts.
    const docs =
      args.cityLower !== null
        ? await ctx.db
            .query("partnerSearchDocs")
            .withIndex("by_city_lower", (q) => q.eq("cityLower", args.cityLower as string))
            .take(CANDIDATE_LIMIT)
        : await ctx.db.query("partnerSearchDocs").take(CANDIDATE_LIMIT);

    const candidates: Candidate[] = [];
    for (const d of docs) {
      if (excluded.has(d.sourceId)) continue;
      candidates.push({
        sourceId: d.sourceId,
        name: d.name,
        // partnerSearchDocs stores the lowercased city (it is the index key);
        // the display spelling comes from the `partners` row below.
        city: null,
        tags: d.tags,
        tagsNorm: d.tagsNorm,
        vec: toTsVector(d),
      });
    }
    const byId = new Map(candidates.map((c) => [c.sourceId, c]));

    // ── vec branch ──────────────────────────────────────────────
    // Resolve the embedding doc ids the action returned back to partner ids,
    // preserving the cosine ordering the vector index produced.
    //
    // THE NULL-EMBEDDING CASE IS NOT "NO BRANCH". Verified live against the
    // Postgres original (2026-08-12): with `query_embedding = NULL` the SQL's
    // vec CTE still emits 40 rows, because `row_number() over (order by
    // g.profile_embedding <=> NULL)` ranks a NULL expression quite happily,
    // while `1 - (embedding <=> NULL)` leaves every `similarity` NULL. Those
    // rows carry no score yet still contribute `1/(60 + rnk)` to rrf_score and
    // still occupy slots in the `limit match_count`.
    //
    // Skipping the branch here would have made the degrade path return ~half
    // as many rows as Supabase does, with a different payload size on a path
    // this project measures. So it is reproduced.
    //
    // ONE DELIBERATE DIFFERENCE: Postgres' order over an all-NULL expression is
    // arbitrary scan order (observed: neither id nor insertion order). This
    // codebase requires determinism (CLAUDE.md §12.7), so the degenerate
    // ranking is id-ascending. It cannot change the agent's behaviour either
    // way: every one of these rows has `similarity: null`, which
    // resolve-partners.ts maps to 0 and then rejects against
    // `similarityThreshold` — the open defect in CLAUDE.md §10.3, faithfully
    // reproduced.
    const vecRanks = new Map<number, BranchHit>();
    if (args.embeddingWasNull) {
      const degenerate = [...candidates]
        .sort((a, b) => a.sourceId - b.sourceId)
        .slice(0, BRANCH_LIMIT);
      degenerate.forEach((c, i) => {
        vecRanks.set(c.sourceId, { rnk: i + 1, score: null });
      });
    } else {
      let rnk = 0;
      for (const hit of args.vec) {
        const doc = await ctx.db.get(hit.embeddingDocId);
        if (!doc) continue; // raced with a reseed
        if (excluded.has(doc.sourceId)) continue;
        // `join geo g using (id)` — a vector hit outside the candidate set is
        // dropped by the join. With the city filter applied on both sides this
        // should never fire; it is the join, not a guard.
        if (!byId.has(doc.sourceId)) continue;
        vecRanks.set(doc.sourceId, { rnk: ++rnk, score: hit.similarity });
      }
    }

    // ── kw branch: ts_rank over websearch_to_tsquery('german', query_text) ──
    const q = websearchToTsQuery(args.queryText);
    const kwRanks =
      q === null
        ? new Map<number, BranchHit>()
        : rankBranch(
            candidates
              .filter((c) => matchesTsQuery(c.vec, q)) // `g.fts @@ q`
              .map((c) => ({ sourceId: c.sourceId, score: tsRank(c.vec, q) })),
          );

    // ── nm branch: pg_trgm similarity(name, query_text) > 0.25 ─────────────
    const nmRanks =
      args.queryText === null || args.queryText === ""
        ? new Map<number, BranchHit>()
        : rankBranch(
            candidates
              .map((c) => ({
                sourceId: c.sourceId,
                score: trigramSimilarity(c.name, args.queryText as string),
              }))
              .filter((r) => r.score > NAME_SIM_FLOOR),
          );

    // ── tg branch: |tags_norm ∩ qtags.slugs| > 0 ───────────────────────────
    const qtags = await expandTags(ctx, args.tags);
    const tgRanks =
      qtags.size === 0 // `where cardinality(qtags.slugs) > 0`
        ? new Map<number, BranchHit>()
        : rankBranch(
            candidates
              .map((c) => ({
                sourceId: c.sourceId,
                score: c.tagsNorm.reduce((n, t) => n + (qtags.has(t) ? 1 : 0), 0),
              }))
              .filter((r) => r.score > 0),
          );

    // ── full outer join + RRF ─────────────────────────────────────────────
    const fused = fusedIds([vecRanks, kwRanks, nmRanks, tgRanks])
      .map((id) => {
        const vecHit = vecRanks.get(id);
        const kwHit = kwRanks.get(id);
        const nmHit = nmRanks.get(id);
        const tgHit = tgRanks.get(id);
        return {
          sourceId: id,
          similarity: vecHit?.score ?? null,
          fts_rank: kwHit?.score ?? null,
          name_sim: nmHit?.score ?? null,
          tag_overlap: tgHit?.score ?? null,
          rrf_score:
            rrfContribution(vecHit) +
            rrfContribution(kwHit) +
            rrfContribution(nmHit) +
            rrfContribution(tgHit),
        };
      })
      // `order by rrf_score desc, g.id` then `limit match_count`
      .sort(compareByRrf)
      .slice(0, Math.max(0, Math.floor(args.matchCount)));

    // Hydrate the display columns the RPC's final SELECT returns. Only for the
    // rows that survived the limit — at most `match_count` reads.
    const out = [];
    for (const row of fused) {
      const candidate = byId.get(row.sourceId);
      const partner = await ctx.db
        .query("partners")
        .withIndex("by_source_id", (qq) => qq.eq("sourceId", row.sourceId))
        .unique();

      out.push({
        partner_id: row.sourceId,
        title: partner?.name ?? candidate?.name ?? "",
        city: partner?.city ?? null,
        // The RPC selects `g.tags` — the RAW tags array, not tags_norm.
        tags: candidate?.tags ?? partner?.tags ?? null,
        distance_km: null, // only non-null under the unimplemented `near` filter
        similarity: row.similarity,
        fts_rank: row.fts_rank,
        name_sim: row.name_sim,
        tag_overlap: row.tag_overlap,
        rrf_score: row.rrf_score,
      });
    }

    return out;
  },
});
