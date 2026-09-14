/**
 * Stage 4 — ONE embedding of the retrieval query, then the same vector is
 * used for a similarity search in every city (bounded fan-out). A failing
 * city is a warning; a failing embedding is the stage's error.
 */
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../lib/reused/embeddings";
import { runWithLimit } from "../../lib/reused/limiter";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { Candidate, CitySearchResult, SearchCity, SearchOutput, StageContext, StageResult } from "../types";

export async function search(
  input: { retrievalQuery: string; cities: SearchCity[] },
  ctx: StageContext,
): Promise<StageResult<SearchOutput> & { queryEmbedding: number[] }> {
  const c = ctx.config;
  const callSignal = () => AbortSignal.any([ctx.signal, timeoutSignal(c.callTimeoutMs)]);

  const queryEmbedding = await ctx.deps.embed(input.retrievalQuery, { signal: callSignal() });

  const warnings: string[] = [];
  const settled = await runWithLimit(
    input.cities.map((city) => async () =>
      ctx.deps.backend.matchPartners(
        { queryEmbedding, queryText: input.retrievalQuery, filters: { city: city.city }, matchCount: c.topKSimilarity },
        { signal: callSignal() },
      ),
    ),
    c.maxParallelSearches,
  );

  let candidatesReturned = 0, belowThreshold = 0, citiesFailed = 0;
  const perCity: CitySearchResult[] = [];
  const candidates: Candidate[] = [];
  input.cities.forEach((city, i) => {
    const s = settled[i]!;
    if (s.status === "rejected") {
      citiesFailed++;
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      warnings.push(`Search in ${city.city} failed: ${msg}`);
      perCity.push({ city: city.city, role: city.role, distanceKm: city.distanceKm, requested: c.topKSimilarity, returned: 0, kept: 0, failed: msg, results: [] });
      return;
    }
    candidatesReturned += s.value.length;
    const results: Candidate[] = [];
    s.value.forEach((row, rankInCity) => {
      const similarity = typeof row.similarity === "number" ? row.similarity : null;
      if (similarity !== null && similarity < c.similarityThreshold) { belowThreshold++; return; }
      results.push({
        id: row.partner_id, name: row.title, city: row.city ?? city.city, tags: row.tags ?? [],
        role: city.role, sourceCity: city.city, distanceKm: city.distanceKm, similarity, rankInCity,
      });
    });
    perCity.push({ city: city.city, role: city.role, distanceKm: city.distanceKm, requested: c.topKSimilarity, returned: s.value.length, kept: results.length, results });
    candidates.push(...results);
  });

  return {
    queryEmbedding,
    output: {
      embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, preview: queryEmbedding.slice(0, 8).map((x) => Math.round(x * 1e4) / 1e4) },
      retrievalQuery: input.retrievalQuery,
      perCity,
      candidates,
    },
    config: { topKSimilarity: c.topKSimilarity, similarityThreshold: c.similarityThreshold, maxParallelSearches: c.maxParallelSearches },
    filters: { cities: input.cities.map((x) => x.city), similarityThreshold: c.similarityThreshold },
    counts: { citiesSearched: input.cities.length, citiesFailed, candidatesReturned, belowThreshold, candidates: candidates.length },
    warnings,
  };
}
