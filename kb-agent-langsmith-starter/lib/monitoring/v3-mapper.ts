// Pure: V3's WorkflowTrace (already returned to the widget) → TraceDraft.
// The types below are a structural copy of V3's workflow/types.ts; the widget
// does not import V3 code.
import { FAILURE_PATTERNS } from "../langfuse";
import { describeStep } from "./describe";
import { usageCost } from "./pricing";
import {
  sumUsage,
  type ErrorDraft,
  type StepDraft,
  type StepStatus,
  type TraceDraft,
  type TraceStatus,
  type Usage,
} from "./types";

export interface V3Stage {
  id: "decompose" | "detect-city" | "reformulate" | "nearby-cities" | "search" | "rerank" | "respond";
  title: string;
  status: StepStatus;
  durationMs: number;
  input: unknown;
  output?: unknown;
  config: Record<string, unknown>;
  filters?: Record<string, unknown>;
  counts?: Record<string, number>;
  warnings: string[];
  error?: { message: string };
  usage?: Usage;
  model?: string;
}
export interface V3Task {
  id: string;
  label: string;
  query: string;
  cityMention: string | null;
  priority: number;
}
export interface V3TaskRun {
  task: V3Task;
  status: "ok" | "needs_clarification" | "failed";
  totalMs: number;
  stages: V3Stage[];
  answer?: string;
  recommendations?: unknown[];
  clarification?: string;
  error?: { message: string };
  usage?: Usage;
}
export interface V3WorkflowTrace {
  runId: string;
  startedAt: string;
  totalMs: number;
  status: "ok" | "needs_clarification" | "partial" | "failed";
  input: { query: string; resume?: unknown };
  config: Record<string, unknown>;
  decompose: V3Stage;
  tasks: V3TaskRun[];
  deferred: V3Task[];
  pending: V3Task[];
  stages: V3Stage[];
  answer?: string;
  recommendations?: unknown[];
  clarification?: string;
  error?: { message: string };
  usage?: Usage;
}

export interface V3MapperInput {
  trace: V3WorkflowTrace;
  sessionId: string;
  turnId: string;
  turnIndex?: number;
  origin?: string | null;
  agentVersion: string;
  environment: string;
  upstreamStatus?: number;
}

const STAGE_KIND: Record<V3Stage["id"], StepDraft["kind"]> = {
  decompose: "llm",
  "detect-city": "retrieval",
  reformulate: "llm",
  "nearby-cities": "retrieval",
  search: "tool",
  rerank: "transform",
  respond: "llm",
};

export function classifyError(message: string): string {
  return FAILURE_PATTERNS.find((p) => p.match.test(message))?.error_type ?? "unclassified";
}

function stageStep(stage: V3Stage, key: string, parent: string | null, sequence: number, startedAt: string | null): StepDraft {
  const d = describeStep(stage.id);
  return {
    step_key: key,
    parent_key: parent,
    sequence,
    kind: STAGE_KIND[stage.id],
    name: stage.id,
    title: d.title,
    purpose: d.purpose,
    status: stage.status,
    started_at: startedAt,
    duration_ms: stage.durationMs,
    input: stage.input,
    output: stage.output ?? null,
    tool_name: stage.id === "search" ? "similarity_search" : null,
    model: stage.model ?? null,
    tokens_input: stage.usage?.input ?? null,
    tokens_output: stage.usage?.output ?? null,
    tokens_cached: stage.usage?.cached ?? null,
    cost_estimate_usd: usageCost(stage.model, stage.usage) ?? null,
    warnings: stage.warnings ?? [],
    error: stage.error ?? null,
    metadata: { config: stage.config ?? {}, counts: stage.counts ?? {}, filters: stage.filters ?? {} },
  };
}

export function mapV3Trace(input: V3MapperInput): TraceDraft {
  const t = input.trace;
  const parsedStart = Date.parse(t.startedAt);
  const startMs = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const startedAt = new Date(startMs).toISOString();
  const endedAt = new Date(startMs + (t.totalMs ?? 0)).toISOString();
  const steps: StepDraft[] = [];
  const errors: ErrorDraft[] = [];
  let seq = 1;

  const req = describeStep("request-received");
  steps.push({
    step_key: "request-received",
    sequence: seq++,
    kind: "request",
    name: "request-received",
    title: req.title,
    purpose: "The visitor's message reached the partner workflow.",
    status: "ok",
    started_at: startedAt,
    duration_ms: 0,
    input: { query: t.input.query, resume: t.input.resume ?? null },
    output: null,
  });

  let cursor = startMs;
  const decomposeStage = t.decompose ?? { id: "decompose", title: "", status: "skipped", durationMs: 0, input: null, config: {}, warnings: [] };
  steps.push(stageStep(decomposeStage, "decompose", null, seq++, startedAt));
  cursor += decomposeStage.durationMs;
  if (decomposeStage.error) {
    errors.push({ step_key: "decompose", level: "error", type: classifyError(decomposeStage.error.message), message: decomposeStage.error.message });
  }

  for (const run of t.tasks ?? []) {
    const key = `task:${run.task.id}`;
    const d = describeStep("task", { label: run.task.label });
    const status: StepStatus = run.status === "ok" ? "ok" : run.status === "needs_clarification" ? "warning" : "error";
    steps.push({
      step_key: key,
      sequence: seq++,
      kind: "group",
      name: "task",
      title: d.title,
      purpose: d.purpose,
      status,
      started_at: new Date(cursor).toISOString(),
      duration_ms: run.totalMs,
      input: run.task,
      output:
        run.status === "needs_clarification"
          ? { clarification: run.clarification }
          : run.status === "ok"
            ? { answer: run.answer, recommendations: run.recommendations ?? [] }
            : null,
      error: run.error ?? null,
      warnings: run.status === "needs_clarification" ? [run.clarification ?? "needs clarification"] : [],
      tokens_input: run.usage?.input ?? null,
      tokens_output: run.usage?.output ?? null,
      tokens_cached: run.usage?.cached ?? null,
    });
    if (run.error) errors.push({ step_key: key, level: "error", type: classifyError(run.error.message), message: run.error.message });
    if (run.status === "needs_clarification") {
      errors.push({ step_key: key, level: "warning", type: "needs_clarification", message: run.clarification ?? "needs clarification" });
    }
    let childCursor = cursor;
    (run.stages ?? []).forEach((stage, i) => {
      const childKey = `${key}/${stage.id}`;
      steps.push(stageStep(stage, childKey, key, i + 1, stage.status === "skipped" ? null : new Date(childCursor).toISOString()));
      childCursor += stage.durationMs;
      if (stage.error) errors.push({ step_key: childKey, level: "error", type: classifyError(stage.error.message), message: stage.error.message });
      for (const w of stage.warnings ?? []) errors.push({ step_key: childKey, level: "warning", type: "stage_warning", message: w });
    });
  }

  const finalOutput = t.answer ?? t.clarification ?? "";
  const comp = describeStep("answer-composed");
  steps.push({
    step_key: "answer-composed",
    sequence: seq++,
    kind: "response",
    name: "answer-composed",
    title: comp.title,
    purpose: comp.purpose,
    status: t.status === "failed" ? "error" : "ok",
    started_at: endedAt,
    duration_ms: 0,
    input: {
      tasks: (t.tasks ?? []).map((r) => ({ id: r.task.id, label: r.task.label, status: r.status })),
      deferred: (t.deferred ?? []).map((x) => x.label),
    },
    output: { answer: finalOutput },
  });
  if (t.status === "failed" && t.error && !errors.some((e) => e.message === t.error!.message)) {
    errors.push({ level: "error", type: classifyError(t.error.message), message: t.error.message });
  }

  const stageSteps = steps.filter((s) => s.kind !== "group");
  const totals = sumUsage(stageSteps);
  const models = [...new Set(stageSteps.map((s) => s.model).filter((m): m is string => Boolean(m)))];
  const status: TraceStatus = t.status === "ok" ? "completed" : t.status;
  const hasUsage = stageSteps.some((s) => s.tokens_input != null);
  return {
    session: { id: input.sessionId, agent: "partner", origin: input.origin ?? null },
    trace: {
      session_id: input.sessionId,
      agent: "partner",
      agent_version: input.agentVersion,
      turn_id: input.turnId,
      turn_index: input.turnIndex,
      status,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: t.totalMs ?? 0,
      first_token_ms: null,
      user_input: t.input.query,
      final_output: finalOutput,
      models,
      tools_called: steps.some((s) => s.tool_name === "similarity_search" && s.status !== "skipped") ? ["similarity_search"] : [],
      step_count: steps.length,
      tool_call_count: steps.filter((s) => s.kind === "tool" && s.status !== "skipped").length,
      error_count: errors.filter((e) => e.level === "error").length,
      warning_count: errors.filter((e) => e.level === "warning").length,
      tokens_input: hasUsage ? (t.usage?.input ?? totals.tokens_input) : null,
      tokens_output: hasUsage ? (t.usage?.output ?? totals.tokens_output) : null,
      tokens_cached: hasUsage ? (t.usage?.cached ?? totals.tokens_cached) : null,
      cost_estimate_usd: hasUsage ? totals.cost_estimate_usd : null,
      metadata: {
        run_id: t.runId,
        config: t.config,
        deferred: t.deferred ?? [],
        pending: t.pending ?? [],
        clarification: t.clarification ?? null,
        env: input.environment,
        ...(input.upstreamStatus ? { upstream_status: input.upstreamStatus } : {}),
      },
    },
    steps,
    errors,
  };
}

export function mapV3UpstreamError(
  input: Omit<V3MapperInput, "trace"> & { userInput: string; status: number; body: string; startedAt: string },
): TraceDraft {
  const endedAt = new Date().toISOString();
  const message = `Partner agent returned HTTP ${input.status}: ${input.body.slice(0, 500)}`;
  const req = describeStep("request-received");
  const fail = describeStep("failure");
  return {
    session: { id: input.sessionId, agent: "partner", origin: input.origin ?? null },
    trace: {
      session_id: input.sessionId,
      agent: "partner",
      agent_version: input.agentVersion,
      turn_id: input.turnId,
      turn_index: input.turnIndex,
      status: "failed",
      started_at: input.startedAt,
      ended_at: endedAt,
      user_input: input.userInput,
      final_output: "",
      models: [],
      tools_called: [],
      step_count: 2,
      tool_call_count: 0,
      error_count: 1,
      warning_count: 0,
      metadata: { env: input.environment, upstream_status: input.status },
    },
    steps: [
      {
        step_key: "request-received",
        sequence: 1,
        kind: "request",
        name: "request-received",
        title: req.title,
        purpose: "The visitor's message reached the partner workflow.",
        status: "ok",
        started_at: input.startedAt,
        duration_ms: 0,
        input: { query: input.userInput },
      },
      {
        step_key: "failure",
        sequence: 2,
        kind: "error",
        name: "failure",
        title: fail.title,
        purpose: fail.purpose,
        status: "error",
        started_at: endedAt,
        duration_ms: 0,
        error: { message, type: "upstream_unavailable" },
      },
    ],
    errors: [{ step_key: "failure", level: "error", type: "upstream_unavailable", message }],
    events: [{ type: "partner.upstream_error", session_id: input.sessionId, payload: { status: input.status, turn_id: input.turnId } }],
  };
}
