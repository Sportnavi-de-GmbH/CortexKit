// ERROR CAPTURE + TURN SUMMARY for Langfuse. eve emits failures as stream
// events, never exceptions, so this hook is the only path from an agent
// failure to Langfuse. Traces (agent/instrumentation.ts) keep flowing even if
// this file is deleted — which would silently hide every failure, and leave
// every trace-list row reading "No inputs / No outputs" because the OTLP root
// is a workflow-infrastructure span with no conversation on it.
//
// This hook is the Langfuse sibling of agent/hooks/langsmith.ts and
// agent/hooks/sentry.ts. All three observe the same events independently;
// none of them knows about the others. Adding this one changes nothing about
// the other two.
//
// WHY OTEL SPANS AND NOT THE INGESTION API
// Langfuse's `/api/public/ingestion` REST endpoint is marked LEGACY in the
// instance's own OpenAPI spec ("Please use the OpenTelemetry endpoint"). So
// this hook emits real OTel spans instead, parented to the trace the exporter
// is already filling — the ids come from `traceRefs`, written by
// instrumentation (the two files are bundled separately by eve, so the bridge
// is the filesystem).
//
// If no Langfuse span processor was attached — no Langfuse credentials — these
// spans are still created on Sentry's provider but no Langfuse exporter ever
// sees them. That IS the no-op path; there is no separate enablement check.
//
// IRON RULE: never throw. eve escalates a thrown hook to `turn.failed`, and a
// throw inside a failure-cascade handler to `session.failed`
// (node_modules/eve/docs/guides/hooks.md). Every handler goes through `guard`.
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Context } from "@opentelemetry/api";
import { defineHook } from "eve/hooks";

import {
  failureSpan,
  feedbackRefs,
  langfuseRecordIo,
  retrievalFactsFrom,
  systemPromptStore,
  traceRefs,
  turnIoStore,
  TurnJournal,
  type FailureKind,
  type TraceRef,
} from "../../lib/langfuse";

/** The one emit primitive the hook needs, injectable so tests can assert the
 *  payloads without an OTel provider. */
export interface EmittedSpan {
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | string[]>;
  /** Present => the span is marked ERROR with this status message. */
  error?: string;
  /** Which trace to attach to. Absent => the span starts its own trace. */
  traceRef?: TraceRef;
}

export interface SpanEmitter {
  emit(span: EmittedSpan): void;
}

/** Builds the OTel parent context from ids alone. The parent span object is
 *  long gone by the time a turn ends — OTel only needs its identity. */
function parentContext(ref: TraceRef | undefined): Context {
  if (!ref) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: ref.traceId,
    spanId: ref.rootSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/** The production emitter: real spans through the globally registered
 *  provider, so they pass the same filter, renaming and exporter as every
 *  other span. */
export const otelEmitter: SpanEmitter = {
  emit(span) {
    const tracer = trace.getTracer("navio-partner-langfuse-hook");
    const started = tracer.startSpan(
      span.name,
      { startTime: span.startMs, attributes: span.attributes },
      parentContext(span.traceRef),
    );
    if (span.error !== undefined) {
      started.setStatus({ code: SpanStatusCode.ERROR, message: span.error });
    }
    started.end(span.endMs);
  },
};

type HookHandler = (event: { data?: Record<string, unknown> }, ctx: HookCtx) => Promise<void>;

interface HookCtx {
  agent: { name: string };
  channel?: { kind?: string };
  session: { id: string };
}

const guard =
  (fn: HookHandler): HookHandler =>
  async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch {
      // Observability must never break the agent.
    }
  };

export function handlersFor(
  emitter: SpanEmitter = otelEmitter,
  journal: TurnJournal = new TurnJournal(),
  opts: { recordContent?: boolean; now?: () => number } = {},
): Record<string, HookHandler> {
  const now = opts.now ?? Date.now;
  const recordContent = opts.recordContent ?? langfuseRecordIo();

  /** Last known trace ref per session, in memory.
   *
   *  WHY: `session.failed` fires AFTER `turn.failed`, and `turn.failed` ends
   *  the turn — which clears the on-disk ref. Without this cache the session
   *  failure span finds no parent and opens a SECOND trace, so one failed
   *  request shows up as two. Measured on the FAQ agent 2026-08-12; the same
   *  event ordering applies here. Keep the fallback. */
  const lastRef = new Map<string, TraceRef>();

  function refFor(sessionId: string): TraceRef | undefined {
    const onDisk = traceRefs.get(sessionId);
    if (onDisk) {
      lastRef.set(sessionId, onDisk);
      return onDisk;
    }
    return lastRef.get(sessionId);
  }

  /** The turn currently being journaled. eve stamps `turnId` on the stream
   *  events but not on the hook context, and it is the id the WIDGET sees on the
   *  answer it renders — so it has to be carried across for feedback. */
  const currentTurn = new Map<string, string>();

  /** One summary span per turn, carrying the trace-level fields Langfuse
   *  reads (`langfuse.trace.*`): the visitor's question in, the agent's reply
   *  out, plus retrieval provenance, timing, tokens and tools. Without it the
   *  trace list shows an unreadable row per request. */
  async function finalizeTurn(outcome: "answered" | "failed", ctx: HookCtx, turnId?: string) {
    const at = now();
    const ref = refFor(ctx.session.id);

    // Publish (session, turn) → trace so a visitor's 👍 can name this exact
    // answer. Only answered turns: a failed one has its own ERROR span and
    // there is nothing to rate.
    const resolvedTurn = turnId ?? currentTurn.get(ctx.session.id);
    if (outcome === "answered" && ref && resolvedTurn) {
      feedbackRefs.set(ctx.session.id, resolvedTurn, { traceId: ref.traceId });
    }
    currentTurn.delete(ctx.session.id);
    const systemPrompt = systemPromptStore.get(ctx.session.id);
    systemPromptStore.delete(ctx.session.id);
    // NOTE: turnIoStore is deliberately NOT cleared here. `turn.completed`
    // fires BEFORE the turn and root spans close, and the span processor reads
    // the store as each of those ends — clearing it here left the outer spans
    // with empty input/output on the FAQ agent (measured 2026-08-13).
    // `message.received` overwrites it at the start of the next turn.
    const summary = journal.finalize({
      sessionId: ctx.session.id,
      outcome,
      agentName: ctx.agent?.name ?? "unknown",
      channelKind: ctx.channel?.kind,
      recordContent,
      now: at,
      systemPrompt,
    });
    if (summary) {
      emitter.emit({
        name: summary.name,
        startMs: summary.startMs,
        endMs: summary.endMs,
        attributes: summary.attributes,
        traceRef: ref,
      });
    }
    // The on-disk ref is per-turn and instrumentation rewrites it on the next
    // turn, so clearing it here keeps `.data/` from growing. `lastRef` keeps
    // the ids available for the session-level events that follow.
    traceRefs.delete(ctx.session.id);
  }

  async function capture(kind: FailureKind, subject: string, data: unknown, ctx: HookCtx) {
    const at = now();
    const story = failureSpan({
      kind,
      subject,
      data,
      sessionId: ctx.session.id,
      agentName: ctx.agent?.name ?? "unknown",
      channelKind: ctx.channel?.kind,
      question: turnIoStore.get(ctx.session.id)?.question,
      recordContent,
    });
    emitter.emit({
      name: story.name,
      startMs: at,
      endMs: at,
      attributes: story.attributes,
      error: story.statusMessage,
      traceRef: refFor(ctx.session.id),
    });
  }

  return {
    // --- Turn journal: accumulate the story of the current turn -----------
    "message.received": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.received", event.data, now());
      const turnId = event.data?.turnId;
      if (typeof turnId === "string" && turnId !== "") currentTurn.set(ctx.session.id, turnId);
      // Publish the question for the SPAN PROCESSOR, which is bundled
      // separately and otherwise exports eve's spans with a null input.
      const message = event.data?.message;
      turnIoStore.set(ctx.session.id, {
        question: typeof message === "string" ? message : undefined,
      });
    }),
    "step.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "step.completed", event.data, now());
    }),
    // First streamed content. For this agent that gap is 30–60s on a search,
    // so time-to-first-token is the number that decides whether the widget
    // read as working or as hung.
    "message.appended": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.appended", event.data, now());
    }),
    "message.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.completed", event.data, now());
      // The reply lands before the turn/root spans close, so the processor can
      // still stamp it onto them as their output.
      const text = (event.data?.text ?? event.data?.message ?? event.data?.content) as unknown;
      if (typeof text === "string" && text.trim() !== "") {
        turnIoStore.set(ctx.session.id, {
          ...(turnIoStore.get(ctx.session.id) ?? {}),
          reply: text,
        });
      }
    }),
    // A turn can end by ASKING rather than answering. `ask_question` is
    // disabled on this agent (CLAUDE.md §10.2), so clarification arrives as
    // normal prose — but eve can still emit this, and a turn that asked is not
    // a turn that answered.
    "input.requested": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "input.requested", event.data, now());
    }),
    "turn.completed": guard(async (event, ctx) => {
      const turnId = event.data?.turnId;
      await finalizeTurn("answered", ctx, typeof turnId === "string" ? turnId : undefined);
    }),

    // --- Tool results: provenance on success, a story on failure -----------
    "action.result": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "action.result", event.data, now());
      const result = event.data?.result as
        | { isError?: boolean; toolName?: string; output?: unknown }
        | undefined;

      if (!result?.isError) {
        // WHAT WAS ACTUALLY RETRIEVED — the question a RAG trace has to answer.
        // eve gives hooks the FULL execute() return, not the trimmed
        // toModelOutput (eve docs, tools/overview.mdx), so the search's own
        // accounting is here without touching find_partners.ts. Published for
        // the span processor, which stamps it onto the model call's input.
        if (result?.toolName === "find_partners") {
          const facts = retrievalFactsFrom(result.output);
          if (facts) {
            turnIoStore.set(ctx.session.id, {
              ...(turnIoStore.get(ctx.session.id) ?? {}),
              retrieval: facts,
            });
          }
        }
        return; // successes are already on the OTel trace
      }
      await capture("tool", result.toolName ?? "unknown_tool", result.output, ctx);
    }),

    "step.failed": guard(async (event, ctx) => {
      await capture("step", String(event.data?.code ?? "step_error"), event.data, ctx);
    }),

    "turn.failed": guard(async (event, ctx) => {
      await capture("turn", String(event.data?.code ?? "turn_error"), event.data, ctx);
      await finalizeTurn("failed", ctx);
    }),

    // The last event of a dead session — capture, then release the cache.
    "session.failed": guard(async (event, ctx) => {
      await capture("session", String(event.data?.code ?? "session_error"), event.data, ctx);
      lastRef.delete(ctx.session.id);
    }),
    // Deliberately absent: turn.cancelled — a cancel is not a failure, and
    // would fire on every stop click.
  };
}

export default defineHook({ events: handlersFor() as never });
