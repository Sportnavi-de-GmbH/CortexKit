/**
 * lib/partners/similarity-search-partners.ts
 *
 * Inside ONE given city, return the top-k most relevant partners for the
 * user's intent, using the existing hybrid-search RPC `match_partners`. This
 * is the ONLY place similarity search is used (gap-filling).
 *
 * Ported from eve-agent-plan/agent/tools/similarity-search-partners.ts
 * (design reference, read-only). Degrades to text-only search if the
 * embedding service is unavailable (E25).
 *
 * DEVIATIONS from the design reference (verified live against the RPC body
 * via `pg_get_functiondef`, see M3a report):
 *  - `filters` only supports `city`, `postal_prefix`, `exclude_ids`, `near`.
 *    There is no `is_active` filter key — the RPC hardcodes `p.is_active`
 *    internally, so it is always applied and must NOT be passed in filters.
 *  - `filters.tags` does not FILTER rows; it only feeds the `tag_overlap` /
 *    `rrf_score` ranking signal. True tag filtering (`requireTagMatch`, E30)
 *    is therefore applied client-side here, using the RPC's own
 *    `tag_overlap` column (computed server-side against `tags_norm`).
 *  - `match_partners` does not return `body_markdown` or `website_url` —
 *    only partner_id/title/city/tags/distance_km/similarity/fts_rank/
 *    name_sim/tag_overlap/rrf_score. Those two `SimilarityHit` fields come
 *    back `null` here; a caller needing them must follow up with
 *    `get_partner_profiles` (get-partner-details.ts).
 *  - The returned `tags` column is `partners.tags` (raw), not `tags_norm`
 *    (the RPC does not expose `tags_norm` in its result set).
 *  - Passing `query_embedding: null` does not error (the function is not
 *    `STRICT`); the `vec` CTE simply degrades to a no-op and the `kw`/`nm`
 *    (full-text / name-similarity) CTEs still rank rows — confirmed live.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
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

interface MatchPartnersRow {
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

export async function similaritySearchPartners(
  input: SimilaritySearchInput,
  supabase: SupabaseClient = getSupabase(),
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

  // 2) Hybrid search, scoped to this city, active only (enforced by the RPC).
  //    `tags` MUST be passed: match_partners builds its `qtags` CTE from
  //    filters->'tags' (expanding through tag_synonyms and okf.tag_variants),
  //    and the `tg` ranking CTE is guarded by `cardinality(qtags.slugs) > 0`.
  //    Omitting the key left `tag_overlap` NULL on every row — verified live —
  //    which killed one of the four RRF branches outright AND made the
  //    client-side `requireTagMatch` filter below discard 100% of candidates.
  let query = supabase.rpc("match_partners", {
    query_embedding: queryEmbedding,
    query_text: input.intent.text,
    filters: {
      city: input.city,
      ...(input.intent.tags.length > 0 ? { tags: input.intent.tags } : {}),
    },
    match_count: input.k,
  });
  if (opts?.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) {
    throw new Error(`similaritySearchPartners: match_partners RPC failed: ${error.message}`);
  }

  let rows = (data ?? []) as MatchPartnersRow[];

  if (input.requireTagMatch && input.intent.tags.length > 0) {
    rows = rows.filter((r) => (r.tag_overlap ?? 0) > 0);
  }

  const hits: SimilarityHit[] = rows.map((r) => ({
    id: r.partner_id,
    name: r.title,
    city: r.city,
    tags_norm: r.tags, // RPC returns raw `tags`, not `tags_norm` — see file header
    body_markdown: null, // not returned by match_partners — see file header
    website_url: null, // not returned by match_partners — see file header
    similarity: r.similarity ?? 0,
  }));

  return { hits, warnings };
}
