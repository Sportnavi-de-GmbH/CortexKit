/**
 * workflow/run-workflow.ts — the runner.
 * Stage 0 splits the message into tasks; each runnable task then goes
 * through stages 1–6 (`runTask`, strictly in order) inside a pool of at
 * most `maxTasksPerTurn` (≤ 3). Every stage becomes a StageRecord; the
 * per-task answers are composed by pure code. The runner NEVER throws.
 */
import { randomUUID } from "node:crypto";
import { resolveConfig, type WorkflowConfig } from "../config/workflow.config";
import { runWithLimit } from "../lib/reused/limiter";
import { compose, CLARIFICATION } from "./compose";
import { decompose } from "./stages/0-decompose";
import { detectCity } from "./stages/1-detect-city";
import { reformulate } from "./stages/2-reformulate";
import { nearbyCities } from "./stages/3-nearby-cities";
import { search } from "./stages/4-search";
import { rerank } from "./stages/5-rerank";
import { respond } from "./stages/6-respond";
import type { StageContext, StageId, StageRecord, StageResult, Task, TaskRun, WorkflowDeps, WorkflowInput, WorkflowStatus, WorkflowTrace } from "./types";

export { CLARIFICATION };

const TITLES: Record<StageId, string> = {
  decompose: "Decompose message",
  "detect-city": "Detect city", reformulate: "Reformulate question", "nearby-cities": "Find nearby cities",
  search: "Embed once + similarity search", rerank: "Combine, dedupe, rerank", respond: "Final response",
};
const TASK_ORDER: StageId[] = ["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"];

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

/**
 * Stages 1–6 for ONE task. `cityHint` is stage 0's cityMention for this task
 * (undefined ⇒ stage 1 asks the model itself). Never throws.
 */
export async function runTask(task: Task, input: WorkflowInput, ctx: StageContext, cityHint: string | null | undefined): Promise<TaskRun> {
  const t0 = performance.now();
  const stages: StageRecord[] = [];
  const skipRest = () => { for (const id of TASK_ORDER.slice(stages.length)) stages.push(skipped(id)); };
  const stageError = (record: StageRecord): { message: string } | undefined =>
    record.error && { message: `${record.title}: ${record.error.message}` };
  const done = (partial: Partial<TaskRun> & { status: TaskRun["status"] }): TaskRun =>
    ({ task, totalMs: Math.round(performance.now() - t0), stages, ...partial });
  const query = task.query;

  // 1
  const s1 = await runStage("detect-city", { query, homeCity: input.homeCity, sessionCities: input.sessionCities, cityMention: cityHint },
    () => detectCity({ query, homeCity: input.homeCity, sessionCities: input.sessionCities, cityMention: cityHint }, ctx));
  stages.push(s1.record);
  if (!s1.result) { skipRest(); return done({ status: "failed", error: stageError(s1.record) }); }
  const target = s1.result.output.target;
  if (!target) { skipRest(); return done({ status: "needs_clarification", clarification: CLARIFICATION }); }

  // 2
  const s2 = await runStage("reformulate", { query }, () => reformulate({ query }, ctx));
  stages.push(s2.record);
  if (!s2.result) { skipRest(); return done({ status: "failed", error: stageError(s2.record) }); }
  const retrievalQuery = s2.result.output.retrievalQuery;

  // 3
  const s3 = await runStage("nearby-cities", { target: target.canonical, centroid: target.centroid }, () => nearbyCities({ target }, ctx));
  stages.push(s3.record);
  if (!s3.result) { skipRest(); return done({ status: "failed", error: stageError(s3.record) }); }
  const cities = s3.result.output.cities;

  // 4 — `queryEmbedding` is captured via closure so stage 5 reuses the same
  // vector without re-embedding; it is assigned before the wrapped promise
  // resolves, and only on success (a throw skips stage 5 anyway).
  let queryEmbedding: number[] = [];
  const s4 = await runStage("search", { retrievalQuery, cities: cities.map((c) => c.city) }, async () => {
    const r = await search({ retrievalQuery, cities }, ctx);
    queryEmbedding = r.queryEmbedding;
    return r;
  });
  stages.push(s4.record);
  if (!s4.result) { skipRest(); return done({ status: "failed", error: stageError(s4.record) }); }

  // 5
  const candidates = s4.result.output.candidates;
  const s5 = await runStage("rerank", { candidates: candidates.length }, () => rerank({ candidates, queryEmbedding }, ctx));
  stages.push(s5.record);
  if (!s5.result) { skipRest(); return done({ status: "failed", error: stageError(s5.record) }); }

  // 6
  const kept = s5.result.output.kept;
  const s6 = await runStage("respond", { query, targetCity: target.canonical, kept: kept.map((k) => k.id) }, () => respond({ query, targetCity: target.canonical, kept }, ctx));
  stages.push(s6.record);
  if (!s6.result) return done({ status: "failed", error: stageError(s6.record) });

  return done({ status: "ok", answer: s6.result.output.answer, recommendations: s6.result.output.recommendations });
}

function overallStatus(tasks: TaskRun[]): WorkflowStatus {
  const s = tasks.map((t) => t.status);
  if (s.length && s.every((x) => x === "failed")) return "failed";
  if (s.some((x) => x === "failed")) return "partial";
  if (s.some((x) => x === "needs_clarification")) return "needs_clarification";
  return "ok";
}

export async function runWorkflow(input: WorkflowInput, overrides: Partial<WorkflowConfig> = {}, deps?: WorkflowDeps): Promise<WorkflowTrace> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const runId = randomUUID();
  const done = (partial: Partial<WorkflowTrace> & { status: WorkflowStatus; config: WorkflowConfig }): WorkflowTrace =>
    ({ runId, startedAt, totalMs: Math.round(performance.now() - t0), input, decompose: skipped("decompose"), tasks: [], deferred: [], pending: [], stages: [], ...partial });

  let config: WorkflowConfig;
  try {
    config = resolveConfig(overrides);
  } catch (e) {
    return done({ status: "failed", config: { ...(overrides as WorkflowConfig) }, error: { message: (e as Error).message } });
  }
  // `createDeps()` builds the real ports and throws synchronously when the
  // Azure / Supabase / embedding credentials are missing. That must become a
  // failed trace, not an exception escaping the runner.
  let d: WorkflowDeps;
  try {
    d = deps ?? (await import("./deps")).createDeps();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return done({ status: "failed", config, error: { message: `dependencies: ${message}` } });
  }
  const ctx: StageContext = { config, deps: d, signal: AbortSignal.timeout(config.runTimeoutMs) };

  // 0 — disabled ⇒ recorded as skipped, but the split still happens (one task).
  const resume = input.resume;
  const s0 = await runStage("decompose", { query: input.query, pending: resume?.pending.map((p) => p.id) ?? [], deferred: resume?.deferred.map((d) => d.id) ?? [] },
    () => decompose({ query: input.query, resume }, ctx));
  if (!s0.result) return done({ status: "failed", config, decompose: s0.record, error: { message: `${s0.record.title}: ${s0.record.error?.message}` } });
  const decomposeRecord = config.enableDecomposition ? s0.record : skipped("decompose");
  const { runnable, deferred, degraded, fresh } = s0.result.output;
  const freshIds = new Set(fresh);

  // 1–6 per task, at most maxTasksPerTurn at once. runTask never throws, but
  // a rejection here would otherwise lose the task silently.
  const settled = await runWithLimit(
    runnable.map((task) => () => runTask(task, input, ctx, config.enableDecomposition && freshIds.has(task.id) && !degraded ? task.cityMention : undefined)),
    config.maxTasksPerTurn,
  );
  const tasks: TaskRun[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { task: runnable[i]!, status: "failed", totalMs: 0, stages: TASK_ORDER.map(skipped), error: { message: s.reason instanceof Error ? s.reason.message : String(s.reason) } },
  );

  const status = overallStatus(tasks);
  const composed = compose({ tasks, deferred });
  const failed = tasks.filter((t) => t.status === "failed");
  const error =
    status === "failed" || status === "partial"
      ? tasks.length === 1
        ? failed[0]!.error
        : { message: failed.map((t) => `${t.task.label}: ${t.error?.message ?? "failed"}`).join("; ") }
      : undefined;

  return done({
    status, config, decompose: decomposeRecord, tasks, deferred, pending: composed.pending,
    stages: tasks.length === 1 ? tasks[0]!.stages : [],
    ...(status !== "failed" && composed.answer !== undefined ? { answer: composed.answer } : {}),
    ...(tasks.length === 1 && tasks[0]!.recommendations ? { recommendations: tasks[0]!.recommendations } : {}),
    ...(composed.clarification ? { clarification: composed.clarification } : {}),
    ...(error ? { error } : {}),
  });
}
