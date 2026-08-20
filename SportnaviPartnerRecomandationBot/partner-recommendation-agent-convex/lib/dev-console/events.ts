import type { HandleMessageStreamEvent } from "eve/client";

export type EventCategory =
  | "lifecycle"
  | "message"
  | "reasoning"
  | "tool"
  | "subagent"
  | "hitl"
  | "auth"
  | "error";

const ERROR_TYPES = new Set(["step.failed", "turn.failed", "session.failed"]);
const TOOL_TYPES = new Set(["actions.requested", "action.result"]);
const SUBAGENT_TYPES = new Set(["subagent.called", "subagent.started", "subagent.completed", "subagent.event"]);
const HITL_TYPES = new Set(["input.requested"]);
const AUTH_TYPES = new Set(["authorization.required", "authorization.completed"]);
const MESSAGE_TYPES = new Set(["message.received", "message.appended", "message.completed", "result.completed"]);
const REASONING_TYPES = new Set(["reasoning.appended", "reasoning.completed"]);

export function eventCategory(event: HandleMessageStreamEvent): EventCategory {
  if (ERROR_TYPES.has(event.type)) return "error";
  if (TOOL_TYPES.has(event.type)) return "tool";
  if (SUBAGENT_TYPES.has(event.type)) return "subagent";
  if (HITL_TYPES.has(event.type)) return "hitl";
  if (AUTH_TYPES.has(event.type)) return "auth";
  if (REASONING_TYPES.has(event.type)) return "reasoning";
  if (MESSAGE_TYPES.has(event.type)) return "message";
  return "lifecycle";
}

const CATEGORY_COLOR: Record<EventCategory, string> = {
  lifecycle: "var(--text-faint)",
  message: "var(--blue)",
  reasoning: "var(--purple)",
  tool: "var(--accent)",
  subagent: "var(--green)",
  hitl: "var(--yellow)",
  auth: "var(--yellow)",
  error: "var(--red)",
};

export function categoryColor(category: EventCategory): string {
  return CATEGORY_COLOR[category];
}

export function eventSummary(event: HandleMessageStreamEvent): string {
  switch (event.type) {
    case "session.started":
      return event.data.invocation
        ? `subagent session (${event.data.invocation.name})`
        : `session started${event.data.runtime ? ` • ${event.data.runtime.modelId}` : ""}`;
    case "turn.started":
      return `turn #${event.data.sequence}`;
    case "message.received":
      return truncate(event.data.message, 120);
    case "actions.requested":
      return event.data.actions
        .map((a) => (a.kind === "tool-call" ? a.toolName : a.kind === "load-skill" ? "load-skill" : a.name))
        .join(", ");
    case "action.result": {
      const r = event.data.result;
      const name = r.kind === "tool-result" ? r.toolName : r.kind === "subagent-result" ? r.subagentName : r.name;
      return `${name ?? r.kind} → ${event.data.status}`;
    }
    case "input.requested":
      return event.data.requests.map((r) => r.prompt).join(" • ");
    case "subagent.called":
      return `→ ${event.data.name}`;
    case "subagent.started":
      return event.data.subagentName;
    case "subagent.completed":
      return `${event.data.subagentName} done`;
    case "message.appended":
      return truncate(event.data.messageDelta, 80);
    case "reasoning.appended":
      return truncate(event.data.reasoningDelta, 80);
    case "message.completed":
      return event.data.message ? truncate(event.data.message, 120) : `(${event.data.finishReason})`;
    case "reasoning.completed":
      return truncate(event.data.reasoning, 120);
    case "result.completed":
      return truncate(JSON.stringify(event.data.result), 120);
    case "step.started":
      return `step ${event.data.stepIndex}`;
    case "step.completed": {
      const u = event.data.usage;
      return `step ${event.data.stepIndex} • ${event.data.finishReason}${u?.inputTokens != null ? ` • ${u.inputTokens}↑/${u.outputTokens ?? 0}↓ tok` : ""}`;
    }
    case "step.failed":
      return `${event.data.code}: ${event.data.message}`;
    case "turn.completed":
      return `turn #${event.data.sequence} complete`;
    case "turn.failed":
      return `${event.data.code}: ${event.data.message}`;
    case "compaction.requested":
      return "compacting history…";
    case "compaction.completed":
      return "compaction checkpoint written";
    case "authorization.required":
      return event.data.description;
    case "authorization.completed":
      return `${event.data.name} → ${event.data.outcome}`;
    case "session.waiting":
      return "waiting for next input";
    case "session.failed":
      return `${event.data.code}: ${event.data.message}`;
    case "session.completed":
      return "session complete";
    default:
      return "";
  }
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function eventTimestamp(event: HandleMessageStreamEvent): string | undefined {
  return event.meta?.at;
}

export function formatClock(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface ToolCallRecord {
  readonly callId: string;
  readonly kind: string;
  readonly name: string;
  readonly input: unknown;
  readonly requestedAt?: string;
  readonly turnId: string;
  readonly stepIndex: number;
  status: "pending" | "completed" | "failed" | "rejected";
  output?: unknown;
  error?: { code: string; message: string };
  resolvedAt?: string;
}

export function correlateToolCalls(events: readonly HandleMessageStreamEvent[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  const order: string[] = [];

  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        const name =
          action.kind === "tool-call"
            ? action.toolName
            : action.kind === "load-skill"
              ? "load_skill"
              : action.kind === "subagent-call"
                ? action.subagentName
                : action.remoteAgentName;
        if (!byId.has(action.callId)) order.push(action.callId);
        byId.set(action.callId, {
          callId: action.callId,
          kind: action.kind,
          name,
          input: "input" in action ? action.input : undefined,
          requestedAt: eventTimestamp(event),
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          status: "pending",
        });
      }
    } else if (event.type === "action.result") {
      const r = event.data.result;
      const existing = byId.get(r.callId);
      const status: ToolCallRecord["status"] =
        event.data.status === "rejected" ? "rejected" : event.data.status === "failed" ? "failed" : "completed";
      if (existing) {
        existing.status = status;
        existing.output = r.output;
        existing.error = event.data.error;
        existing.resolvedAt = eventTimestamp(event);
      } else {
        const name = r.kind === "tool-result" ? r.toolName : r.kind === "subagent-result" ? r.subagentName : r.name;
        order.push(r.callId);
        byId.set(r.callId, {
          callId: r.callId,
          kind: r.kind,
          name: name ?? r.kind,
          input: undefined,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          status,
          output: r.output,
          error: event.data.error,
          resolvedAt: eventTimestamp(event),
        });
      }
    }
  }

  return order.map((id) => byId.get(id)!);
}

export type ActionStatus = "done" | "running" | "error";

export interface ActionRow {
  readonly id: string;
  readonly label: string;
  readonly time?: string;
  readonly status: ActionStatus;
}

const ACTION_CATEGORIES = new Set<EventCategory>(["tool", "subagent", "hitl", "auth", "error"]);

function actionStatus(event: HandleMessageStreamEvent): ActionStatus {
  if (eventCategory(event) === "error") return "error";
  switch (event.type) {
    case "action.result":
      return event.data.status === "completed" ? "done" : "error";
    case "subagent.completed":
    case "compaction.completed":
      return "done";
    case "authorization.completed":
      return event.data.outcome === "authorized" ? "done" : "error";
    default:
      return "running";
  }
}

/** The most recent notable things the agent did — tool calls, subagent hops, approvals, errors. */
export function recentActions(events: readonly HandleMessageStreamEvent[], limit: number): ActionRow[] {
  const rows: ActionRow[] = [];
  for (const event of events) {
    const isCompaction = event.type === "compaction.requested" || event.type === "compaction.completed";
    if (!ACTION_CATEGORIES.has(eventCategory(event)) && !isCompaction) continue;
    rows.push({
      id: `${event.type}-${eventTimestamp(event) ?? rows.length}`,
      label: eventSummary(event) || event.type,
      time: eventTimestamp(event),
      status: actionStatus(event),
    });
  }
  return rows.slice(-limit).reverse();
}
