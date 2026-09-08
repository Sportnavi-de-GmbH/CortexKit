// ERROR CAPTURE + TURN SUMMARY. eve emits failures as stream events, never
// exceptions, so this hook is the only path from an agent failure to Langfuse.
// Traces (agent/instrumentation.ts) keep flowing even if this file is deleted —
// which would silently hide every failure. Do not delete it.
//
// WHY OTEL SPANS AND NOT THE INGESTION API
// Langfuse's `/api/public/ingestion` REST endpoint is marked LEGACY in the
// instance's own OpenAPI spec ("Please use the OpenTelemetry endpoint"). So
// this hook emits real OTel spans instead, parented to the trace the exporter
// is already filling — the ids come from `traceRefs`, written by
// instrumentation (the two files are bundled separately by eve, so the bridge
// is the filesystem).
//
// If the OTel provider was never registered — no Langfuse credentials — the
// global tracer is a no-op tracer and every span here silently evaporates.
// That IS the no-op path; there is no separate enablement check.
//
// IRON RULE: never throw. A thrown hook becomes turn.failed; a throw in a
// failure-cascade handler becomes session.failed. Every handler is guarded.
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Context,
} from "@opentelemetry/api";
import { defineHook } from "eve/hooks";

import {
  failureSpan,
  flushActiveTraceProvider,
  feedbackRefs,
  langfuseRecordIo,
  systemPromptStore,
  traceRefs,
  turnIoStore,
  TurnJournal,
  type FailureKind,
  type TraceRef,
} from "../../lib/langfuse.ts";

/** The one emit primitive the hook needs, injectable so tests can assert the
 *  payloads without an OTel provider. */
export interface EmittedSpan {
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | string[]>;
  /** Present ⇒ the span is marked ERROR with this status message. */
  error?: string;
  /** Which trace to attach to. Absent ⇒ the span starts its own trace. */
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
    const tracer = trace.getTracer("navio-langfuse-hook");
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
   *  failure span found no parent and opened a SECOND trace, so one failed
   *  request showed up as two. Verified live on 2026-08-12: the failure run
   *  produced traces 9c9ed41f… and c825a563…. Keep the fallback. */
  const lastRef = new Map<string, TraceRef>();

  function refFor(sessionId: string): TraceRef | undefined {
    const onDisk = traceRefs.get(sessionId);
    if (onDisk) {
      lastRef.set(sessionId, onDisk);
      return onDisk;
    }
    return lastRef.get(sessionId);
  }

  /** The turn currently being journaled, per session. eve puts `turnId` on the
   *  stream events but not on the hook context, and it is the key the WIDGET
   *  uses to identify an answer (`message.metadata.turnId`) — so it has to be
   *  carried across from the events to the feedback map. */
  const currentTurn = new Map<string, string>();

  /** One summary span per turn, carrying the trace-level fields Langfuse
   *  reads (`langfuse.trace.*`): the user's question in, the agent's reply
   *  out, plus timing/tokens/tools. Without it the trace list shows an
   *  unreadable row per request — the OTLP root is an infrastructure span
   *  that can never carry business context. */
  async function finalizeTurn(outcome: "answered" | "failed", ctx: HookCtx, turnId?: string) {
    const at = now();
    const ref = refFor(ctx.session.id);

    // Publish (session, turn) → trace BEFORE anything can clear the ref, so a
    // visitor who hits 👍 the instant the answer lands still scores the right
    // trace. Only answered turns get one: there is nothing to rate about a turn
    // that failed, and the failure already has its own ERROR span.
    const resolvedTurn = turnId ?? currentTurn.get(ctx.session.id);
    if (outcome === "answered" && ref && resolvedTurn) {
      feedbackRefs.set(ctx.session.id, resolvedTurn, { traceId: ref.traceId });
    }
    currentTurn.delete(ctx.session.id);
    const systemPrompt = systemPromptStore.get(ctx.session.id);
    systemPromptStore.delete(ctx.session.id);
    // NOTE: turnIoStore is deliberately NOT cleared here. `turn.completed`
    // fires BEFORE the turn and root spans close, and the span processor reads
    // the store as each of those ends — deleting it here left `answer-question`
    // and `visitor-request` with empty input/output (measured 2026-08-13).
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
      // eve stamps every stream event with the turn it belongs to, and the
      // widget sees the same id on the assistant message it renders. Keeping it
      // here is what lets a 👍 name one specific answer.
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
    // First streamed content — the difference between "the widget felt
    // instant" and "the bubble sat empty". Recorded as timing.first_token_ms.
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
    "turn.completed": guard(async (event, ctx) => {
      const turnId = event.data?.turnId;
      await finalizeTurn("answered", ctx, typeof turnId === "string" ? turnId : undefined);
      // Serverless: last hook of the turn — export the batch before the freeze.
      await flushActiveTraceProvider();
    }),

    // --- Failure capture ---------------------------------------------------
    "action.result": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "action.result", event.data, now());
      const result = event.data?.result as
        | { isError?: boolean; toolName?: string; output?: unknown }
        | undefined;
      if (!result?.isError) return; // successes are already on the OTel trace
      await capture("tool", result.toolName ?? "unknown_tool", result.output, ctx);
    }),

    "step.failed": guard(async (event, ctx) => {
      await capture("step", String(event.data?.code ?? "step_error"), event.data, ctx);
    }),

    "turn.failed": guard(async (event, ctx) => {
      await capture("turn", String(event.data?.code ?? "turn_error"), event.data, ctx);
      await finalizeTurn("failed", ctx);
      await flushActiveTraceProvider(); // see turn.completed
    }),

    // The last event of a dead session — capture, then release the cache.
    "session.failed": guard(async (event, ctx) => {
      await capture("session", String(event.data?.code ?? "session_error"), event.data, ctx);
      lastRef.delete(ctx.session.id);
      await flushActiveTraceProvider(); // see turn.completed
    }),
    // Deliberately absent: turn.cancelled — a cancel is not a failure.
  };
}

export default defineHook({ events: handlersFor() as never });
