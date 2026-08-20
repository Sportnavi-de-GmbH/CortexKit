/**
 * lib/partners/score-relevance.ts
 *
 * R13 §4 — the ONE relevance-scoring function for everything that can be
 * shown. Client-side cosine between the per-search intent embedding and each
 * partner's stored `profile_embedding`, shared VERBATIM between the Supabase
 * and Convex builds so scores are bitwise-identical across the A/B benchmark
 * (only the embedding *fetch* differs per build — see
 * lib/partners/get-partner-embeddings.ts).
 *
 * Why not `match_partners` scoped to the home city: its vector branch is
 * hardcoded to `limit 40` (CLAUDE.md §10.2), so a 100-partner city would get
 * 40 scores and 60 nulls — the exact defect class (§10.1–10.3) this module
 * exists to retire. Why not a scoring RPC: two divergent server-side
 * implementations of the same arithmetic is the silent-drift hazard the
 * Convex parity tests police.
 *
 * Determinism rules (do not weaken):
 *  - scores are rounded to 4 decimal places BEFORE any comparison, absorbing
 *    float-order differences between builds/platforms;
 *  - every downstream sort tiebreaks id-ascending;
 *  - no randomness, no wall-clock inputs.
 */

/** Round to 4 dp — the comparison granularity for all relevance decisions. */
export function roundScore(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** Plain cosine similarity; returns 0 for zero-magnitude vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Score a set of partners against one intent embedding. Ids missing from
 * `partnerEmbeddings` are simply absent from the result — callers treat an
 * absent score as "unscored", never as 0 (0 is a real score; absent means
 * the data was unavailable).
 */
export function scoreRelevance(
  intentEmbedding: readonly number[],
  partnerEmbeddings: ReadonlyMap<number, readonly number[]>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, emb] of partnerEmbeddings) {
    out.set(id, roundScore(cosineSimilarity(intentEmbedding, emb)));
  }
  return out;
}

export interface RelevanceCutoffOptions {
  /** ρ in `cutoff = top − ρ·(top − median)`. Scale-free. Default 0.5. */
  relevanceBand: number;
  /** Snap the boundary to the largest score drop within ±snapWindow ranks. */
  snapWindow: number;
  /** A drop must be at least this large to count as a knee. */
  minKneeGap: number;
  /** Never cut below this many (callers may still shrink for budget). */
  shortlistMin: number;
  /** Never select more than this many via the cutoff. */
  shortlistMax: number;
}

export const DEFAULT_CUTOFF_OPTIONS: RelevanceCutoffOptions = {
  relevanceBand: 0.5,
  snapWindow: 2,
  minKneeGap: 0.02,
  shortlistMin: 3,
  shortlistMax: 24,
};

/**
 * R13 §4.2 — how many of these scores count as "relevant" for this intent.
 *
 * A fixed absolute threshold is exactly what §10.1–10.3 proved broken
 * (similarity scores are uncalibrated across intents). This cutoff is
 * self-normalizing per (city, intent): relative to the top and median score,
 * then snapped to the largest consecutive drop nearby so ±0.003 embedding
 * jitter cannot flip the boundary.
 *
 * `scores` may be in any order; only their multiset matters. Returns a count
 * in [min(scores.length, shortlistMin) … min(scores.length, shortlistMax)].
 * Degenerate cases: fewer than shortlistMin scores → all count; all scores
 * equal (generic intent — the whole city IS relevant) → all count up to
 * shortlistMax.
 */
export function relevanceCutoffCount(
  scores: readonly number[],
  opts: Partial<RelevanceCutoffOptions> = {},
): number {
  const o = { ...DEFAULT_CUTOFF_OPTIONS, ...opts };
  const sorted = [...scores].map(roundScore).sort((a, b) => b - a);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n <= o.shortlistMin) return n;

  const top = sorted[0]!;
  const median = sorted[Math.floor((n - 1) / 2)]!;
  const cutoff = roundScore(top - o.relevanceBand * (top - median));

  let k = 0;
  while (k < n && sorted[k]! >= cutoff) k++;

  // Snap to the largest gap within ±snapWindow ranks of k (boundary between
  // index i-1 and i means "keep i"). Only gaps ≥ minKneeGap qualify.
  const lo = Math.max(o.shortlistMin, k - o.snapWindow);
  const hi = Math.min(Math.min(n, o.shortlistMax), k + o.snapWindow);
  let bestGap = 0;
  let bestK = k;
  for (let i = lo; i <= hi && i < n; i++) {
    const gap = roundScore(sorted[i - 1]! - sorted[i]!);
    if (gap > bestGap && gap >= o.minKneeGap) {
      bestGap = gap;
      bestK = i;
    }
  }
  k = bestGap > 0 ? bestK : k;

  return Math.max(o.shortlistMin, Math.min(k, o.shortlistMax, n));
}
