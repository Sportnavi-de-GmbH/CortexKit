/**
 * Stage 5 — Combine every city's candidates, remove duplicates, put all of
 * them on ONE relevance scale (cosine of the query embedding vs the stored
 * partner embedding), add the location term, order, cut to topKReranked.
 * `finalScore = relevance + locationTerm`. A clearly more relevant nearby
 * partner can beat a weak target-city partner; an equally relevant one cannot.
 */
import { roundScore, scoreRelevance } from "../../lib/reused/score-relevance";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { WorkflowConfig } from "../../config/workflow.config";
import type { Candidate, RankedRow, RerankOutput, StageContext, StageResult } from "../types";

export interface RerankContext extends StageContext { queryEmbedding: number[] }
/**
 * A `Reranker` returns rows ALREADY in final order — it owns the sort, not
 * just the scoring. It sets `kept: false` + `dropReason` only for floor
 * drops (e.g. below `minNearbyRelevance`); `rank` is always left `null`.
 * The `rerank()` wrapper below assigns ranks in row order and applies the
 * `topKReranked` cut, so a reranker must never assign `rank` or reorder rows
 * after this point.
 */
export interface Reranker {
  name: string;
  rerank(candidates: Candidate[], ctx: RerankContext): Promise<{ rows: RankedRow[]; warnings: string[]; floorDropped: number }>;
}

export function combineAndDedupe(candidates: Candidate[]): { unique: Candidate[]; duplicatesRemoved: number } {
  const best = new Map<number, Candidate>();
  const better = (a: Candidate, b: Candidate) => (a.role === "target") !== (b.role === "target") ? a.role === "target" : a.distanceKm < b.distanceKm;
  for (const c of candidates) {
    const cur = best.get(c.id);
    if (!cur || better(c, cur)) best.set(c.id, c);
  }
  return { unique: [...best.values()], duplicatesRemoved: candidates.length - best.size };
}

export function locationTerm(role: "target" | "nearby", distanceKm: number, cfg: WorkflowConfig): number {
  if (role === "target") return cfg.targetCityBonus;
  const frac = Math.min(1, Math.max(0, distanceKm / cfg.searchRadiusKm));
  return -cfg.maxDistancePenalty * frac;
}

interface RankPair { row: RankedRow; rankInCity: number }

function order(a: RankPair, b: RankPair): number {
  return b.row.finalScore - a.row.finalScore
    || Number(b.row.role === "target") - Number(a.row.role === "target")
    || a.row.distanceKm - b.row.distanceKm
    || a.rankInCity - b.rankInCity
    || a.row.id - b.row.id;
}

export const embeddingReranker: Reranker = {
  name: "embedding",
  async rerank(candidates, ctx) {
    const warnings: string[] = [];
    const ids = candidates.map((c) => c.id);
    const signal = AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
    const embRows = ids.length ? await ctx.deps.backend.getPartnerEmbeddings(ids, { signal }) : [];
    const queryDim = ctx.queryEmbedding.length;

    const returnedIds = new Set(embRows.map((r) => r.id));
    const mismatched = embRows.filter((r) => r.embedding.length !== queryDim);
    const validRows = embRows.filter((r) => r.embedding.length === queryDim);

    const scores = scoreRelevance(ctx.queryEmbedding, new Map(validRows.map((r) => [r.id, r.embedding])));

    const missing = ids.filter((id) => !returnedIds.has(id));
    if (missing.length) warnings.push(`${missing.length} candidate(s) have no stored embedding; using the directory similarity as relevance: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);

    if (mismatched.length) {
      const idsByDim = new Map<number, number[]>();
      for (const r of mismatched) {
        const list = idsByDim.get(r.embedding.length) ?? [];
        list.push(r.id);
        idsByDim.set(r.embedding.length, list);
      }
      for (const [dim, idsForDim] of idsByDim) {
        warnings.push(`${idsForDim.length} candidate(s) have a stored embedding of ${dim} dims but the query has ${queryDim}; falling back to the directory similarity for: ${idsForDim.slice(0, 10).join(", ")}${idsForDim.length > 10 ? ", …" : ""}`);
      }
    }

    let floorDropped = 0;
    const pairs: RankPair[] = candidates.map((c) => {
      const fromEmb = scores.get(c.id);
      const relevance = fromEmb ?? (c.similarity !== null ? roundScore(c.similarity) : 0);
      const relevanceSource: RankedRow["relevanceSource"] = fromEmb !== undefined ? "embedding" : c.similarity !== null ? "similarity" : "none";
      const lt = roundScore(locationTerm(c.role, c.distanceKm, ctx.config));
      const row: RankedRow = {
        rank: null, id: c.id, name: c.name, city: c.city, role: c.role, distanceKm: c.distanceKm, similarity: c.similarity,
        relevance, relevanceSource, locationTerm: lt, finalScore: roundScore(relevance + lt), kept: true,
      };
      if (c.role === "nearby" && relevance < ctx.config.minNearbyRelevance) {
        row.kept = false; row.dropReason = `relevance ${relevance} below minNearbyRelevance ${ctx.config.minNearbyRelevance}`; floorDropped++;
      }
      return { row, rankInCity: c.rankInCity };
    });
    pairs.sort(order);
    return { rows: pairs.map((p) => p.row), warnings, floorDropped };
  },
};

const RERANKERS: Record<WorkflowConfig["reranker"], Reranker> = { embedding: embeddingReranker };

export async function rerank(input: { candidates: Candidate[]; queryEmbedding: number[] }, ctx: StageContext): Promise<StageResult<RerankOutput>> {
  const c = ctx.config;
  const { unique, duplicatesRemoved } = combineAndDedupe(input.candidates);
  const impl = RERANKERS[c.reranker];
  const { rows, warnings, floorDropped } = await impl.rerank(unique, { ...ctx, queryEmbedding: input.queryEmbedding });

  let rank = 0;
  for (const r of rows) {
    if (!r.kept) continue;
    if (rank >= c.topKReranked) { r.kept = false; r.dropReason = `beyond topKReranked ${c.topKReranked}`; continue; }
    r.rank = ++rank;
  }
  const kept = rows.filter((r) => r.kept);
  return {
    output: { reranker: impl.name, rows, kept },
    config: { reranker: c.reranker, topKReranked: c.topKReranked, targetCityBonus: c.targetCityBonus, maxDistancePenalty: c.maxDistancePenalty, minNearbyRelevance: c.minNearbyRelevance, searchRadiusKm: c.searchRadiusKm },
    counts: { combined: input.candidates.length, duplicatesRemoved, unique: unique.length, floorDropped, kept: kept.length },
    warnings,
  };
}
