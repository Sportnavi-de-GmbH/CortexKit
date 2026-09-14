// Pure state for the V3 "workflow" partner agent adapter (lib/use-workflow-agent.ts).
//
// V3 (SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3) is not an
// eve agent: one `POST /api/workflow` returns a whole WorkflowTrace instead of an
// SSE turn. NavioWidget only ever reads `data.messages`, `status`, `error` and
// `session`, so this module projects a trace into the same EveMessage shape the
// eve reducer would have produced — the widget component stays untouched.
//
// Multi-turn state lives here as well: V3 returns `pending` (tasks that asked a
// clarifying question) and `deferred` (tasks beyond its parallel cap) and expects
// them back as `resume` on the next request.

import type { EveMessage } from "eve/react";
import { V3_RESULT_KIND, type V3Recommendation, type V3Task } from "./v3-answer";

export interface WorkflowTaskLite {
  id: string;
  label: string;
  query: string;
  cityMention: string | null;
  priority: number;
}

export interface WorkflowResume {
  pending: WorkflowTaskLite[];
  deferred: WorkflowTaskLite[];
}

/** One executed task of the trace — only what the cards need. */
export interface WorkflowTaskRunLite {
  task: WorkflowTaskLite;
  status: "ok" | "needs_clarification" | "failed";
  recommendations?: V3Recommendation[];
}

/** The subset of V3's WorkflowTrace the widget consumes. */
export interface WorkflowTraceLite {
  runId: string;
  status: "ok" | "needs_clarification" | "partial" | "failed";
  answer?: string;
  clarification?: string;
  error?: { message: string };
  pending: WorkflowTaskLite[];
  deferred: WorkflowTaskLite[];
  tasks?: WorkflowTaskRunLite[];
}

export interface WorkflowAgentState {
  readonly messages: readonly EveMessage[];
  readonly turn: number;
  readonly resume: WorkflowResume | null;
  readonly error: Error | undefined;
}

export function initialWorkflowState(): WorkflowAgentState {
  return { messages: [], turn: 0, resume: null, error: undefined };
}

const turnId = (n: number) => `turn_${n}`;

export function applyUserMessage(s: WorkflowAgentState, text: string): WorkflowAgentState {
  const turn = s.turn + 1;
  const msg: EveMessage = {
    id: `u-${turn}`,
    role: "user",
    parts: [{ type: "text", text, state: "done" }],
    metadata: { status: "submitted", turnId: turnId(turn) },
  };
  return { messages: [...s.messages, msg], turn, resume: s.resume, error: undefined };
}

function markLastUserFailed(messages: readonly EveMessage[]): EveMessage[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "user") {
      out[i] = { ...m, metadata: { ...m.metadata, status: "failed" } };
      break;
    }
  }
  return out;
}

export function applyTrace(s: WorkflowAgentState, trace: WorkflowTraceLite): WorkflowAgentState {
  const text = trace.answer ?? trace.clarification;
  if (trace.status === "failed" || !text) {
    const message = trace.error?.message ?? "Die Partnersuche ist gerade nicht erreichbar.";
    return { ...s, messages: markLastUserFailed(s.messages), error: new Error(message) };
  }
  // Structured partner facts ride on eve's `metadata.result` slot (the harness
  // "structured result" of a turn), so the widget's message type is unchanged.
  const tasks: V3Task[] = (trace.tasks ?? [])
    .filter((t) => t.status === "ok" && Array.isArray(t.recommendations))
    .map((t) => ({ label: t.task.label, recommendations: t.recommendations ?? [] }));
  const reply: EveMessage = {
    id: `a-${trace.runId}`,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }],
    metadata: { status: "complete", turnId: turnId(s.turn), ...(tasks.length ? { result: { kind: V3_RESULT_KIND, tasks } } : {}) },
  };
  const hasCarry = trace.pending.length > 0 || trace.deferred.length > 0;
  return {
    messages: [...s.messages, reply],
    turn: s.turn,
    resume: hasCarry ? { pending: trace.pending, deferred: trace.deferred } : null,
    error: undefined,
  };
}

export function applyFailure(s: WorkflowAgentState, error: Error): WorkflowAgentState {
  return { ...s, messages: markLastUserFailed(s.messages), error };
}
