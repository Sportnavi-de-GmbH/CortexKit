/**
 * convex/lib/rrf.ts — the Reciprocal Rank Fusion arithmetic from
 * `match_partners`, isolated as pure functions.
 *
 * The SQL is:
 *
 *   <branch> as (
 *     select g.id, row_number() over (order by <score> desc) as rnk, <score>
 *     from geo g where <predicate> order by <score> desc limit 40
 *   ),
 *   ...
 *   coalesce(1.0 / (60 + vec.rnk), 0)
 * + coalesce(1.0 / (60 + kw.rnk),  0)
 * + coalesce(1.0 / (60 + nm.rnk),  0)
 * + coalesce(1.0 / (60 + tg.rnk),  0) as rrf_score
 *
 * Kept in its own module (rather than inline in convex/searchRanking.ts)
 * because searchRanking.ts imports ./_generated, which only exists after
 * codegen — and the fusion is the part most worth unit-testing without a
 * deployment. tests/convex/sql-equivalence.test.ts pins it.
 */

/** The per-branch cap the SQL hardcodes (`limit 40` in each of vec/kw/nm/tg). */
export const BRANCH_LIMIT = 40;

/** The RRF smoothing constant from the SQL: `1.0 / (60 + rnk)`. */
export const RRF_K = 60;

export interface BranchHit {
  /** 1-based, as `row_number()` produces. */
  rnk: number;
  /**
   * The branch's own score column (similarity / fts_rank / name_sim /
   * tag_overlap).
   *
   * NULLABLE because of one real Postgres behaviour: when `query_embedding` is
   * NULL, the `vec` CTE still produces 40 ranked rows — `row_number()` orders
   * by a NULL expression, which is legal and arbitrary — while every
   * `1 - (embedding <=> NULL)` is NULL. So a row can be RANKED (and contribute
   * to rrf_score) while carrying no score at all. See convex/searchRanking.ts.
   */
  score: number | null;
}

/**
 * `row_number() over (order by score desc)` followed by `limit BRANCH_LIMIT`.
 *
 * Ties are broken by partner id ascending. The SQL leaves them unordered —
 * `row_number()` over equal scores is not deterministic in Postgres — and this
 * codebase requires determinism (CLAUDE.md §12.7), so the tiebreak is added
 * rather than inherited.
 */
export function rankBranch(
  scored: ReadonlyArray<{ sourceId: number; score: number }>,
  limit: number = BRANCH_LIMIT,
): Map<number, BranchHit> {
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.sourceId - b.sourceId);
  const out = new Map<number, BranchHit>();
  sorted.slice(0, limit).forEach((row, i) => {
    out.set(row.sourceId, { rnk: i + 1, score: row.score });
  });
  return out;
}

/** `coalesce(1.0 / (60 + rnk), 0)` for one branch. */
export function rrfContribution(hit: BranchHit | undefined): number {
  return hit === undefined ? 0 : 1 / (RRF_K + hit.rnk);
}

/** The full-outer-join key set: every id present in ANY branch. */
export function fusedIds(branches: ReadonlyArray<Map<number, BranchHit>>): number[] {
  const ids = new Set<number>();
  for (const branch of branches) for (const id of branch.keys()) ids.add(id);
  return [...ids];
}

/** `order by rrf_score desc, g.id` — the SQL's final ordering, deterministic. */
export function compareByRrf(
  a: { rrf_score: number; sourceId: number },
  b: { rrf_score: number; sourceId: number },
): number {
  return b.rrf_score - a.rrf_score || a.sourceId - b.sourceId;
}
