/**
 * workflow/run-workflow.ts — the sequential runner.
 * Six stages, strictly in order. Each becomes a StageRecord in the trace
 * (input, output, config used, filters, counts, warnings, error, duration).
 * The runner NEVER throws: a stage error stops the run with status "failed",
 * later stages are recorded as "skipped".
 */
import { randomUUID } from "node:crypto";
import { resolveConfig, type WorkflowConfig } from "../config/workflow.config";
import { detectCity } from "./stages/1-detect-city";
import { reformulate } from "./stages/2-reformulate";
import { nearbyCities } from "./stages/3-nearby-cities";
import { search } from "./stages/4-search";
import { rerank } from "./stages/5-rerank";
import { respond } from "./stages/6-respond";
import type { StageContext, StageId, StageRecord, StageResult, WorkflowDeps, WorkflowInput, WorkflowTrace } from "./types";

const TITLES: Record<StageId, string> = {
  decompose: "Decompose message",
  "detect-city": "Detect city", reformulate: "Reformulate question", "nearby-cities": "Find nearby cities",
  search: "Embed once + similarity search", rerank: "Combine, dedupe, rerank", respond: "Final response",
};
const ORDER: StageId[] = ["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"];

export const CLARIFICATION = "In welcher Stadt (oder Umgebung) suchst du? Sag mir kurz den Ort, dann finde ich passende Angebote.";

function skipped(id: StageId): StageRecord {
  return { id, title: TITLES[id], status: "skipped", durationMs: 0, input: null, config: {}, warnings: [] };
}

async function runStage<I, O>(id: StageId, input: I, fn: () => Promise<StageResult<O>>): Promise<{ record: StageRecord<I, O>; result?: StageResult<O> }> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const warnings = result.warnings ?? [];
    return {
      record: {
        id, title: TITLES[id], status: warnings.length ? "warning" : "ok", durationMs: Math.round(performance.now() - t0),
        input, output: result.output, config: result.config, ...(result.filters ? { filters: result.filters } : {}), ...(result.counts ? { counts: result.counts } : {}), warnings,
      },
      result,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { record: { id, title: TITLES[id], status: "error", durationMs: Math.round(performance.now() - t0), input, config: {}, warnings: [], error: { message } } };
  }
}

export async function runWorkflow(input: WorkflowInput, overrides: Partial<WorkflowConfig> = {}, deps?: WorkflowDeps): Promise<WorkflowTrace> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const runId = randomUUID();
  const done = (partial: Partial<WorkflowTrace> & { status: WorkflowTrace["status"]; config: WorkflowConfig; stages: StageRecord[] }): WorkflowTrace =>
    ({ runId, startedAt, totalMs: Math.round(performance.now() - t0), input, decompose: skipped("decompose"), tasks: [], deferred: [], pending: [], ...partial });

  let config: WorkflowConfig;
  try {
    config = resolveConfig(overrides);
  } catch (e) {
    return done({ status: "failed", config: { ...(overrides as WorkflowConfig) }, stages: [], error: { message: (e as Error).message } });
  }
  // `createDeps()` builds the real ports and throws synchronously when the
  // Azure / Supabase / embedding credentials are missing. That must become a
  // failed trace, not an exception escaping the runner.
  let d: WorkflowDeps;
  try {
    d = deps ?? (await import("./deps")).createDeps();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return done({ status: "failed", config, stages: [], error: { message: `dependencies: ${message}` } });
  }
  const ctx: StageContext = { config, deps: d, signal: AbortSignal.timeout(config.runTimeoutMs) };
  const stages: StageRecord[] = [];
  const skipRest = () => { for (const id of ORDER.slice(stages.length)) stages.push(skipped(id)); };
  // Mirrors a failed stage's error into the trace's top-level `error`, so a
  // stage failure has the same shape as the config-failure case above.
  const stageError = (record: StageRecord): { message: string } | undefined =>
    record.error && { message: `${record.title}: ${record.error.message}` };

  // 1
  const s1 = await runStage("detect-city", { query: input.query, homeCity: input.homeCity, sessionCities: input.sessionCities }, () => detectCity(input, ctx));
  stages.push(s1.record);
  if (!s1.result) { skipRest(); return done({ status: "failed", config, stages, error: stageError(s1.record) }); }
  const target = s1.result.output.target;
  if (!target) { skipRest(); return done({ status: "needs_clarification", config, stages, clarification: CLARIFICATION }); }

  // 2
  const s2 = await runStage("reformulate", { query: input.query }, () => reformulate({ query: input.query }, ctx));
  stages.push(s2.record);
  if (!s2.result) { skipRest(); return done({ status: "failed", config, stages, error: stageError(s2.record) }); }
  const retrievalQuery = s2.result.output.retrievalQuery;

  // 3
  const s3 = await runStage("nearby-cities", { target: target.canonical, centroid: target.centroid }, () => nearbyCities({ target }, ctx));
  stages.push(s3.record);
  if (!s3.result) { skipRest(); return done({ status: "failed", config, stages, error: stageError(s3.record) }); }
  const cities = s3.result.output.cities;

  // 4
  // Stage 4 returns its full query vector alongside the normal StageResult
  // (`search()`'s return type is intersected with `{ queryEmbedding }`).
  // `queryEmbedding` is captured here via closure so stage 5 can reuse the
  // same vector without re-embedding. It is assigned synchronously before
  // the wrapped fn's promise resolves, so it's populated by the time
  // `runStage` returns — but only on success: if `search()` throws,
  // `runStage`'s catch takes over and this line never runs, which is fine
  // because stage 5 is skipped in that case anyway (see the `!s4.result`
  // check just below).
  let queryEmbedding: number[] = [];
  const s4 = await runStage("search", { retrievalQuery, cities: cities.map((c) => c.city) }, async () => {
    const r = await search({ retrievalQuery, cities }, ctx);
    queryEmbedding = r.queryEmbedding;
    return r;
  });
  stages.push(s4.record);
  if (!s4.result) { skipRest(); return done({ status: "failed", config, stages, error: stageError(s4.record) }); }

  // 5
  const candidates = s4.result.output.candidates;
  const s5 = await runStage("rerank", { candidates: candidates.length }, () => rerank({ candidates, queryEmbedding }, ctx));
  stages.push(s5.record);
  if (!s5.result) { skipRest(); return done({ status: "failed", config, stages, error: stageError(s5.record) }); }

  // 6
  const kept = s5.result.output.kept;
  const s6 = await runStage("respond", { query: input.query, targetCity: target.canonical, kept: kept.map((k) => k.id) }, () => respond({ query: input.query, targetCity: target.canonical, kept }, ctx));
  stages.push(s6.record);
  if (!s6.result) return done({ status: "failed", config, stages, error: stageError(s6.record) });

  return done({ status: "ok", config, stages, answer: s6.result.output.answer, recommendations: s6.result.output.recommendations });
}
