/**
 * lib/partners/get-partner-embeddings.ts — CONVEX PORT.
 *
 * R13 §4.1 — fetch stored `profile_embedding` vectors for a set of partner
 * ids, for client-side relevance scoring (lib/partners/score-relevance.ts,
 * which is shared VERBATIM with the Supabase build so scores are
 * bitwise-identical across the A/B benchmark).
 *
 * This is a DATA-LAYER file (the fifth in the parity allowance — see
 * MIGRATION-NOTES.md): only the fetch differs from the Supabase build —
 * point-reads on `partnerEmbeddings.by_source_id` via the ConvexBackend's
 * sixth operation, instead of a `select id, profile_embedding` query.
 *
 * Embeddings are static between partner imports, so results are cached for
 * 24h per partner id. `invalidateEmbeddingCache()` must be called alongside
 * `invalidateSearchCache()` after an import.
 */

import { getConvex, type ConvexBackend } from "../convex";
import { createTtlCache } from "../cache";

const EMBEDDING_CACHE_TTL_SEC = 86_400; // matches neighborsCacheTtlSec
const EMBEDDING_CACHE_MAX_ENTRIES = 5_000; // > directory size; bounded anyway

const cache = createTtlCache<readonly number[]>(
  EMBEDDING_CACHE_TTL_SEC,
  () => Date.now(),
  EMBEDDING_CACHE_MAX_ENTRIES,
);

/** Call after a partner import, alongside invalidateSearchCache(). */
export function invalidateEmbeddingCache(): void {
  cache.clear();
}

/**
 * Returns a map of id → embedding for every requested id that has one.
 * Missing ids are absent from the map (callers treat absent as "unscored").
 * Throws only on a transport/query error — the caller decides whether that
 * degrades the search or merely skips scoring (it must only skip scoring:
 * relevance is an enhancement layer, never a dependency — R13 §4.1).
 */
export async function getPartnerEmbeddings(
  ids: readonly number[],
  convex?: ConvexBackend,
  signal?: AbortSignal,
): Promise<Map<number, readonly number[]>> {
  const out = new Map<number, readonly number[]>();
  const missing: number[] = [];
  for (const id of ids) {
    const hit = cache.get(String(id));
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  const client = convex ?? getConvex();
  const rows = await client.getPartnerEmbeddings(missing, { signal });
  for (const row of rows) {
    if (row.embedding.length > 0) {
      cache.set(String(row.id), row.embedding);
      out.set(row.id, row.embedding);
    }
  }
  return out;
}

export type GetPartnerEmbeddingsFn = typeof getPartnerEmbeddings;
