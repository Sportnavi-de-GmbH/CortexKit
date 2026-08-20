/**
 * lib/partners/similarity-search-partners.ts
 *
 * Inside ONE given city, return the top-k most relevant partners for the
 * user's intent, using the hybrid-search function `search:matchPartners`. This
 * is the ONLY place similarity search is used (gap-filling).
 *
 * CONVEX PORT of the Supabase build's file of the same name. The Supabase
 * version called the `match_partners` Postgres RPC; this calls the Convex
 * action that reproduces it (convex/search.ts + convex/searchRanking.ts —
 * read those headers for the CTE-by-CTE mapping and the deviation list).
 *
 * The behavioural contract is IDENTICAL and the notes below are the same ones
 * that were verified live against the Postgres function:
 *  - `filters` supports `city`, `exclude_ids` and `tags`. There is no
 *    `is_active` filter key — the search corpus only ever contains active
 *    partners, so it is always applied and must NOT be passed in filters.
 *  - `filters.tags` does not FILTER rows; it only feeds the `tag_overlap` /
 *    `rrf_score` ranking signal. True tag filtering (`requireTagMatch`, E30)
 *    is therefore applied client-side here, using the returned `tag_overlap`
 *    column (computed server-side against `tags_norm`).
 *  - matchPartners does not return `body_markdown` or `website_url` — only
 *    partner_id/title/city/tags/distance_km/similarity/fts_rank/name_sim/
 *    tag_overlap/rrf_score. Those two `SimilarityHit` fields come back `null`
 *    here; a caller needing them must follow up with getPartnerProfiles.
 *  - The returned `tags` column is `partners.tags` (raw), not `tags_norm`.
 *  - Passing `queryEmbedding: null` does not error; the vector branch simply
 *    contributes nothing and the keyword / name-similarity branches still
 *    rank rows — the same degrade the non-STRICT SQL function had.
 *
 * ⚠️ CLAUDE.md §10.3 (OPEN in both builds): on the null-embedding path every
 * returned row has `similarity: null` -> 0, and resolve-partners.ts then
 * rejects all of them against `similarityThreshold`. Reproduced deliberately;
 * fixing it in only one build would invalidate the comparison.
 */

import { getConvex, type ConvexBackend, type ConvexMatchPartnersRow } from "../convex";
import { embedText } from "../embeddings";
import type { Intent, SimilarityHit } from "./types";

export interface SimilaritySearchInput {
  city: string; // the single nearby city to search within
  intent: Intent; // query_text (+ optional tag filter)
  k: number; // gap + dedupHeadroom
  requireTagMatch?: boolean;
  /**
   * Pre-computed embedding for `intent.text`, supplied by the orchestrator so
   * a fan-out over N nearby cities embeds ONCE instead of N times. Gap-fill
   * queries every candidate city concurrently with the same intent text, and
   * the module-level cache in lib/embeddings.ts is only populated after the
   * first call RESOLVES — so concurrent callers all missed and issued N
   * identical embedding requests per search.
   *
   * `null` means "the embedding was attempted and failed" (degrade to
   * text-only, E25); `undefined` means "not supplied — embed here", which is
   * the path tests and any direct caller still take.
   */
  queryEmbedding?: number[] | null;
  /** Warning to propagate when `queryEmbedding` was pre-computed and failed. */
  embeddingWarning?: string;
}

export interface SimilaritySearchResult {
  hits: SimilarityHit[];
  warnings: string[];
}

export async function similaritySearchPartners(
  input: SimilaritySearchInput,
  convex: ConvexBackend = getConvex(),
  opts?: { signal?: AbortSignal },
): Promise<SimilaritySearchResult> {
  const warnings: string[] = [];

  // 1) Embed the intent, unless the orchestrator already did it for the whole
  //    fan-out. Degrades to text-only search on failure (E25).
  let queryEmbedding: number[] | null = null;
  if (input.queryEmbedding !== undefined) {
    queryEmbedding = input.queryEmbedding;
    if (queryEmbedding === null && input.embeddingWarning) {
      warnings.push(input.embeddingWarning);
    }
  } else {
    try {
      queryEmbedding = await embedText(input.intent.text, { signal: opts?.signal });
    } catch (err) {
      queryEmbedding = null;
      warnings.push(
        `embedding unavailable (${err instanceof Error ? err.message : String(err)}); degraded to text-only search`,
      );
    }
  }

  // 2) Hybrid search, scoped to this city, active only (enforced by the
  //    corpus). `tags` MUST be passed: the server builds its `qtags` set from
  //    filters.tags (expanding through tagSynonyms and tagVariants) and the
  //    `tg` ranking branch is guarded by a non-empty slug set. Omitting the
  //    key left `tag_overlap` null on every row — verified live against the
  //    Postgres original — which killed one of the four RRF branches outright
  //    AND made the client-side `requireTagMatch` filter below discard 100%
  //    of candidates (CLAUDE.md §10.10).
  let rows: ConvexMatchPartnersRow[];
  try {
    rows = await convex.matchPartners(
      {
        queryEmbedding,
        queryText: input.intent.text,
        filters: {
          city: input.city,
          ...(input.intent.tags.length > 0 ? { tags: input.intent.tags } : {}),
        },
        matchCount: input.k,
      },
      { signal: opts?.signal },
    );
  } catch (err) {
    throw new Error(
      `similaritySearchPartners: search:matchPartners failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (input.requireTagMatch && input.intent.tags.length > 0) {
    rows = rows.filter((r) => (r.tag_overlap ?? 0) > 0);
  }

  const hits: SimilarityHit[] = rows.map((r) => ({
    id: r.partner_id,
    name: r.title,
    city: r.city,
    tags_norm: r.tags, // raw `tags`, not `tags_norm` — see file header
    body_markdown: null, // not returned by matchPartners — see file header
    website_url: null, // not returned by matchPartners — see file header
    similarity: r.similarity ?? 0,
  }));

  return { hits, warnings };
}
