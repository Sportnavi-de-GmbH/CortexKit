/**
 * events.ts — turns eve's wire events into something a non-engineer can read.
 *
 * The widget hides routing on purpose: the visitor must experience ONE
 * assistant. That makes the product right and the system opaque — when Navio
 * sends a question to the wrong specialist, nothing in the chat shows it.
 *
 * This module is the translation layer for /dev. `actions.requested` becomes
 * "Navio asked the FAQ specialist"; `input.requested` becomes "Waiting for the
 * visitor to approve". Anyone can watch a conversation and see which capability
 * answered and how long each part took.
 *
 * Event shapes come from node_modules/eve/docs/concepts/sessions-runs-and-streaming.md.
 * We read `action.kind` ("tool-call" | "subagent-call") rather than
 * string-matching a serialized payload, so a rename fails loudly instead of
 * silently reporting the wrong route.
 */

import type { EveMessageData, UseEveAgentHelpers } from "eve/react";

export type Agent = UseEveAgentHelpers<EveMessageData>;

/** The capabilities the master can reach. Keep in sync with agent/. */
export const CAPABILITIES = {
  faq: {
    label: "FAQ specialist",
    human: "Looking up Sportnavi's official answer",
    blurb: "Knows tariffs, contracts, check-in, cashback. No tools, no internet.",
  },
  find_partners: {
    label: "Partner search",
    human: "Searching real studios and classes",
    blurb: "Queries the live partner directory. Takes 15–60 seconds.",
  },
  request_human_contact: {
    label: "Human hand-off",
    human: "Offering to pass this to a person",
    blurb: "Needs the visitor's approval before the contact form opens.",
  },
  ask_question: {
    label: "Clarifying question",
    human: "Asking the visitor to narrow it down",
    blurb: "Used when the request is ambiguous.",
  },
} as const;

export type CapabilityId = keyof typeof CAPABILITIES;

export type Kind =
  | "user"
  | "thinking"
  | "route"
  | "route_done"
  | "reply"
  | "hitl"
  | "error"
  | "session";

export type Status = "running" | "done" | "error" | "waiting";

export interface FeedRow {
  id: string;
  /** ms since the turn started, filled by the caller from arrival stamps. */
  at?: number;
  kind: Kind;
  title: string;
  description: string;
  status: Status;
  capability?: CapabilityId;
  /** Exact arguments the model passed to the tool/subagent. */
  input?: unknown;
  /** Exact value the tool/subagent returned. */
  output?: unknown;
  /** The untouched eve stream event, for when the summaries are not enough. */
  raw?: unknown;
  /** Tool/subagent identifier as eve reports it. */
  toolName?: string;
  /** eve's call id, so a call and its result can be matched by eye. */
  callId?: string;
  /** Set on rows that represent a long wait, so the UI can warn. */
  durationMs?: number;
}

type AnyEvent = { type?: string; data?: Record<string, any> };

function truncate(value: unknown, max = 260): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Name of the capability an action targets, whatever kind of action it is. */
function actionName(action: any): string | undefined {
  if (!action) return undefined;
  if (action.kind === "subagent-call") return action.subagentName;
  if (action.kind === "tool-call") return action.toolName;
  if (action.kind === "subagent-result") return action.subagentName;
  if (action.kind === "tool-result") return action.toolName;
  return action.toolName ?? action.subagentName ?? action.name;
}

function isCapability(name: unknown): name is CapabilityId {
  return typeof name === "string" && name in CAPABILITIES;
}

/**
 * Build the human-readable feed for the current session.
 * `stamps[i]` is our local arrival time for `agent.events[i]`.
 */
export function buildFeed(agent: Agent, stamps: number[], t0: number | null): FeedRow[] {
  const rows: FeedRow[] = [];
  const events = agent.events as unknown as AnyEvent[];
  /** callId → index in `rows`, so a result can close the row its call opened. */
  const openCalls = new Map<string, number>();

  events.forEach((event, i) => {
    const at = t0 !== null && stamps[i] !== undefined ? stamps[i] - t0 : undefined;
    const d = event.data ?? {};

    switch (event.type) {
      case "session.started":
        rows.push({
          id: `s-${i}`,
          at,
          kind: "session",
          title: "Conversation started",
          description: "A fresh session — Navio has no memory of earlier visits.",
          status: "done",
        });
        break;

      case "message.received":
        rows.push({
          id: `u-${i}`,
          at,
          kind: "user",
          title: "Visitor said",
          description: truncate(d.message ?? d.text ?? ""),
          status: "done",
        });
        break;

      case "reasoning.completed":
        rows.push({
          id: `r-${i}`,
          at,
          kind: "thinking",
          title: "Navio is thinking",
          description: truncate(d.reasoning, 1200),
          status: "done",
          raw: event,
        });
        break;

      case "actions.requested":
        for (const action of (d.actions ?? []) as any[]) {
          const name = actionName(action);
          const cap = isCapability(name) ? name : undefined;
          const meta = cap ? CAPABILITIES[cap] : undefined;
          rows.push({
            id: `c-${action.callId ?? i}`,
            at,
            kind: "route",
            title: meta ? `Navio chose: ${meta.label}` : `Navio called ${name ?? "something"}`,
            description: meta?.human ?? "Delegating this request.",
            status: "running",
            capability: cap,
            input: action.input,
            raw: event,
            toolName: name,
            callId: action.callId,
          });
          if (action.callId) openCalls.set(action.callId, rows.length - 1);
        }
        break;

      case "action.result": {
        const result = d.result ?? d;
        const callId = result.callId;
        const name = actionName(result);
        const cap = isCapability(name) ? name : undefined;
        const failed = d.status !== undefined && d.status !== "completed";
        // A tool that returns { ok: false } is a business failure, not a crash —
        // surface it as an error anyway, because that is what the visitor feels.
        const output = result.output as any;
        const softFail = output && typeof output === "object" && output.ok === false;

        const openIndex = callId !== undefined ? openCalls.get(callId) : undefined;
        if (openIndex !== undefined) {
          const opened = rows[openIndex];
          opened.status = failed || softFail ? "error" : "done";
          opened.durationMs = at !== undefined && opened.at !== undefined ? at - opened.at : undefined;
        }

        const meta = cap ? CAPABILITIES[cap] : undefined;
        rows.push({
          id: `cr-${callId ?? i}`,
          at,
          kind: "route_done",
          title:
            failed || softFail
              ? `${meta?.label ?? name ?? "That step"} could not help`
              : `${meta?.label ?? name ?? "That step"} answered`,
          description:
            failed || softFail
              ? truncate(output?.error ?? d.error?.message ?? "It returned an error.")
              : summarizeOutput(cap, output),
          status: failed || softFail ? "error" : "done",
          capability: cap,
          input: openIndex !== undefined ? rows[openIndex].input : undefined,
          output,
          raw: event,
          toolName: name,
          callId,
          durationMs:
            openIndex !== undefined ? rows[openIndex].durationMs : undefined,
        });
        break;
      }

      case "input.requested":
        for (const request of (d.requests ?? []) as any[]) {
          rows.push({
            id: `h-${request.requestId ?? i}`,
            at,
            kind: "hitl",
            title: "Waiting for the visitor",
            description:
              request.prompt ??
              "Navio asked permission before handing over to a person. Nothing happens until they choose.",
            status: "waiting",
            input: request,
            raw: event,
          });
        }
        break;

      case "message.completed":
        // Interim narration before a tool call also lands here; only a
        // non-tool-calls finish is the reply the visitor actually reads last.
        rows.push({
          id: `m-${i}`,
          at,
          kind: "reply",
          title: d.finishReason === "tool-calls" ? "Navio said (before delegating)" : "Navio replied",
          description: truncate(d.message, 1500),
          status: "done",
          raw: event,
        });
        break;

      case "step.failed":
      case "turn.failed":
      case "session.failed":
        rows.push({
          id: `e-${i}`,
          at,
          kind: "error",
          title: "Something failed",
          description: truncate(`${d.code ?? ""} ${d.message ?? ""}`.trim()),
          status: "error",
          raw: event,
        });
        break;
    }
  });

  return rows;
}

function summarizeOutput(cap: CapabilityId | undefined, output: any): string {
  if (cap === "find_partners" && output?.ok) {
    return output.searchPerformed
      ? `Returned ${String(output.answer ?? "").length} characters from the live directory.`
      : "⚠ Answered WITHOUT querying the directory — check for hallucination.";
  }
  if (cap === "request_human_contact" && output?.openContactForm) {
    return "The visitor approved. The contact form opens now.";
  }
  if (typeof output === "string") return truncate(output);
  return truncate(output?.answer ?? output);
}

/** Per-turn numbers the architecture proposal says to watch (§9-R1, §9-R2). */
export interface TurnMetrics {
  totalMs: number;
  firstTokenMs: number | null;
  maxGapMs: number;
  routes: CapabilityId[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export function computeMetrics(
  agent: Agent,
  stamps: number[],
  t0: number | null,
  live: boolean,
): TurnMetrics | null {
  if (t0 === null) return null;
  const events = agent.events as unknown as AnyEvent[];
  let firstTokenMs: number | null = null;
  let maxGapMs = 0;
  let prev = t0;
  const routes: CapabilityId[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  events.forEach((event, i) => {
    const at = stamps[i] ?? prev;
    maxGapMs = Math.max(maxGapMs, at - prev);
    prev = at;
    if (event.type === "message.appended" && firstTokenMs === null) firstTokenMs = at - t0;
    if (event.type === "actions.requested") {
      for (const action of (event.data?.actions ?? []) as any[]) {
        const name = actionName(action);
        if (isCapability(name) && !routes.includes(name)) routes.push(name);
      }
    }
    if (event.type === "step.completed") {
      const u = event.data?.usage ?? {};
      inputTokens += u.inputTokens ?? 0;
      outputTokens += u.outputTokens ?? 0;
      cachedTokens += u.cachedInputTokens ?? 0;
    }
  });

  const now = Date.now();
  return {
    totalMs: (live ? now : (stamps[stamps.length - 1] ?? t0)) - t0,
    firstTokenMs,
    // While a turn is live the current silence counts too — that is the whole
    // point of watching this number during a partner search.
    maxGapMs: live ? Math.max(maxGapMs, now - prev) : maxGapMs,
    routes,
    inputTokens,
    outputTokens,
    cachedTokens,
  };
}
