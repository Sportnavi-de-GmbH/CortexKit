// ORCHESTRATION CAPTURE for Langfuse: routing decisions, delegations, failures
// and the per-request summary.
//
// eve emits failures as stream events, never exceptions, so this hook is the
// only path from an agent failure to Langfuse. It is also the only place that
// sees the CONTROL PLANE of the orchestration — `actions.requested` (the model
// choosing a specialist) and `subagent.called` (the delegation actually
// happening, with the child session id). Traces from
// agent/instrumentation.ts keep flowing without it, but the trace would then
// answer "what ran" and not "what Navio decided".
//
// This hook is the Langfuse sibling of agent/hooks/langsmith.ts. The two are
// independent; adding this one changes nothing about the other.
//
// IRON RULE: never throw. eve escalates a thrown hook to `turn.failed`, and a
// throw inside a failure-cascade handler to `session.failed`
// (node_modules/eve/docs/guides/hooks.md). Every handler goes through `guard`.
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Context } from "@opentelemetry/api";
import { defineHook } from "eve/hooks";

import {
  childSessions,
  failureSpan,
  feedbackRefs,
  langfuseRecordIo,
  routeForTool,
  systemPromptStore,
  toolNamesFrom,
  traceRefs,
  turnIoStore,
  TurnJournal,
  type FailureKind,
  type TraceRef,
} from "../../lib/langfuse.ts";

export interface EmittedSpan {
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | string[]>;
  error?: string;
  traceRef?: TraceRef;
}

export interface SpanEmitter {
  emit(span: EmittedSpan): void;
}

function parentContext(ref: TraceRef | undefined): Context {
  if (!ref) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: ref.traceId,
    spanId: ref.rootSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

export const otelEmitter: SpanEmitter = {
  emit(span) {
    const tracer = trace.getTracer("navio-orchestrator-langfuse-hook");
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

  /** `session.failed` fires AFTER `turn.failed`, which clears the on-disk ref.
   *  Without this cache the session-failure span finds no parent and opens a
   *  SECOND trace, so one failed request shows up as two. */
  const lastRef = new Map<string, TraceRef>();

  function refFor(sessionId: string): TraceRef | undefined {
    const onDisk = traceRefs.get(sessionId);
    if (onDisk) {
      lastRef.set(sessionId, onDisk);
      return onDisk;
    }
    return lastRef.get(sessionId);
  }

  /** Publish the turn's state for the SPAN PROCESSOR, which is bundled
   *  separately and otherwise exports eve's spans with a null input. */
  function publish(sessionId: string, patch: Record<string, unknown>): void {
    turnIoStore.set(sessionId, { ...(turnIoStore.get(sessionId) ?? {}), ...patch });
  }

  /** The turn currently in progress, per session. eve stamps `turnId` on the
   *  stream events but not on the hook context, and it is the id the WIDGET
   *  sees on the answer it renders (`message.metadata.turnId`) — so it has to
   *  be carried across here for feedback to name the right answer. */
  const currentTurn = new Map<string, string>();

  async function finalizeTurn(outcome: "answered" | "failed", ctx: HookCtx, turnId?: string) {
    const at = now();
    const ref = refFor(ctx.session.id);

    // Snapshot BEFORE journal.finalize() below — it clears the journal's own
    // turn state, and `routeOf` reads from exactly that state. Read it here or
    // lose it: this is the ONE place a delegated turn's route is still known
    // by the time a visitor's 👍/👎 arrives, seconds or minutes later.
    const route = journal.routeOf(ctx.session.id);
    const partnerSessionId = turnIoStore.get(ctx.session.id)?.partnerSessionId;
    const resolvedTurn = turnId ?? currentTurn.get(ctx.session.id);
    if (outcome === "answered" && ref && resolvedTurn) {
      feedbackRefs.set(ctx.session.id, resolvedTurn, {
        traceId: ref.traceId,
        ...(route ? { route } : {}),
        ...(partnerSessionId ? { partnerSessionId } : {}),
      });
    }
    currentTurn.delete(ctx.session.id);

    const systemPrompt = systemPromptStore.get(ctx.session.id);
    systemPromptStore.delete(ctx.session.id);
    // turnIoStore is deliberately NOT cleared here: `turn.completed` fires
    // BEFORE the turn and root spans close, and the processor reads the store
    // as each of those ends. Clearing it emptied the outer spans on the FAQ
    // agent (measured 2026-08-13). `message.received` overwrites it next turn.
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
    traceRefs.delete(ctx.session.id);
  }

  async function capture(kind: FailureKind, subject: string, data: unknown, ctx: HookCtx) {
    const at = now();
    const io = turnIoStore.get(ctx.session.id);
    const story = failureSpan({
      kind,
      subject,
      data,
      sessionId: ctx.session.id,
      agentName: ctx.agent?.name ?? "unknown",
      channelKind: ctx.channel?.kind,
      question: io?.question,
      route: io?.route,
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
    // --- The request ------------------------------------------------------
    "message.received": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.received", event.data, now());
      const turnId = event.data?.turnId;
      if (typeof turnId === "string" && turnId !== "") currentTurn.set(ctx.session.id, turnId);
      const message = event.data?.message;
      turnIoStore.set(ctx.session.id, {
        question: typeof message === "string" ? message : undefined,
      });
    }),

    "step.started": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "step.started", event.data, now());
    }),
    "step.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "step.completed", event.data, now());
    }),

    // --- THE ROUTING DECISION --------------------------------------------
    // Captured the moment the model asks for a capability and BEFORE the tool
    // runs, which is what makes "where was the routing decision made" and
    // "how long did deciding take" answerable rather than inferred.
    "actions.requested": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "actions.requested", event.data, now());
      const route = journal.routeOf(ctx.session.id);
      if (route) {
        const chosen = toolNamesFrom(event.data).find((n) => routeForTool(n) !== undefined);
        publish(ctx.session.id, { route, routeTool: chosen });
      }
    }),

    // --- DELEGATION -------------------------------------------------------
    // There is deliberately NO `subagent.called` handler. MEASURED 2026-08-18
    // with a wildcard hook over a real delegated turn: the hook layer receives
    // `subagent.completed` but NEVER `subagent.called` — that one reaches the
    // client stream only. The first version of this file subscribed to it and
    // every delegation field came back empty while everything else looked
    // green. `childSessionId` is likewise not available to hooks at all, so the
    // child ids are recorded by instrumentation instead (see delegatedChildren).
    "subagent.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "subagent.completed", event.data, now());
      const name =
        typeof event.data?.subagentName === "string" ? event.data.subagentName : "faq";
      publish(ctx.session.id, {
        route: journal.routeOf(ctx.session.id) ?? routeForTool(name),
        routeTool: name,
      });
    }),

    // --- Delegation results ----------------------------------------------
    "action.result": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "action.result", event.data, now());
      const result = event.data?.result as Record<string, unknown> | undefined;
      // A SUBAGENT result carries `subagentName`; a plain tool result carries
      // `toolName`. Reading only the latter loses every delegation.
      const name =
        (typeof result?.toolName === "string" && result.toolName) ||
        (typeof result?.subagentName === "string" && result.subagentName) ||
        undefined;
      const failed = result?.isError === true || event.data?.status === "failed";

      if (!failed) {
        const out = result?.output as Record<string, unknown> | undefined;

        // A DELEGATION CAN FAIL WITHOUT THE TOOL FAILING.
        //
        // `find_partners` never throws: it RETURNS `{ ok: false, error }` so the
        // model can recover inside the same turn and tell the visitor honestly
        // instead of inventing studios (agent/tools/find_partners.ts). To eve
        // that is a successful tool call, so `isError` is false and the trace
        // would show a clean turn with no error anywhere — while the partner
        // service was down. Surface it as a real ERROR observation, since "where
        // did it break" is exactly what the trace has to answer.
        if (out && out.ok === false && typeof out.error === "string") {
          await capture("tool", name ?? "delegation", out.error, ctx);
          return;
        }

        // Cross-service link: service 2 traces its own search, in full, in its
        // own Langfuse project. Recording its session id here is what lets a
        // reviewer jump from this trace to that one.
        if (name === "find_partners" && out && typeof out.partnerSessionId === "string") {
          publish(ctx.session.id, { partnerSessionId: out.partnerSessionId });
        }
        return; // successes are already on the OTel trace
      }
      await capture("tool", name ?? "unknown_delegation", result?.output ?? event.data, ctx);
    }),

    "message.appended": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.appended", event.data, now());
    }),
    "message.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.completed", event.data, now());
      const text = (event.data?.text ?? event.data?.message ?? event.data?.content) as unknown;
      if (typeof text === "string" && text.trim() !== "") {
        publish(ctx.session.id, { reply: text });
      }
    }),

    // `ask_question` is ENABLED on this agent, unlike elsewhere in Navio — it
    // is the ambiguity mechanism, and such a turn emits ZERO assistant text.
    // Without this the summary has no output and is mislabelled "answered".
    "input.requested": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "input.requested", event.data, now());
      publish(ctx.session.id, { route: journal.routeOf(ctx.session.id) });
    }),

    "turn.completed": guard(async (event, ctx) => {
      const turnId = event.data?.turnId;
      await finalizeTurn("answered", ctx, typeof turnId === "string" ? turnId : undefined);
    }),

    // --- Failures ---------------------------------------------------------
    "step.failed": guard(async (event, ctx) => {
      await capture("step", String(event.data?.code ?? "step_error"), event.data, ctx);
    }),
    "turn.failed": guard(async (event, ctx) => {
      await capture("turn", String(event.data?.code ?? "turn_error"), event.data, ctx);
      await finalizeTurn("failed", ctx);
    }),
    "session.failed": guard(async (event, ctx) => {
      await capture("session", String(event.data?.code ?? "session_error"), event.data, ctx);
      lastRef.delete(ctx.session.id);
    }),
    // Deliberately absent: turn.cancelled — a cancel is not a failure.
  };
}

export default defineHook({ events: handlersFor() as never });
