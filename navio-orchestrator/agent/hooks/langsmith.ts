// ERROR CAPTURE (guide Part B). eve emits failures as stream events, never
// exceptions, so this hook is the only path from an agent failure to a
// LangSmith run. Traces (agent/instrumentation.ts) keep flowing even if this
// file is deleted — which would silently hide every failure. Do not delete it.
//
// IRON RULE: never throw. A thrown hook becomes turn.failed; a throw in a
// failure-cascade handler becomes session.failed. Every handler is guarded.
import { randomUUID } from "node:crypto";

import { defineHook } from "eve/hooks";

import {
  attachmentFor,
  createLangsmithClient,
  failureRunPayload,
  projectName,
  recordIo,
  systemPromptStore,
  traceAnchors,
  TurnJournal,
  type FailureKind,
} from "../../lib/langsmith.ts";

/** The one Client method the hook needs, injectable for tests. */
export interface LangSmithLike {
  createRun(payload: Record<string, unknown>): Promise<unknown>;
}

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
  client: LangSmithLike | undefined,
  project: string,
  journal: TurnJournal = new TurnJournal(),
  opts: { recordContent?: boolean; now?: () => number } = {},
): Record<string, HookHandler> {
  const now = opts.now ?? Date.now;
  const recordContent = opts.recordContent ?? recordIo();

  /** One summary run per turn: user message (+ system prompt) in, agent
   *  reply out, plus timing/tokens/tools metadata. With an anchor it
   *  PRE-CREATES the OTLP trace root, so the whole request is one trace. */
  async function finalizeTurn(outcome: "answered" | "failed", ctx: HookCtx) {
    if (!client) return; // no key = no-op
    const at = now();
    const anchor = traceAnchors.get(ctx.session.id);
    traceAnchors.delete(ctx.session.id);
    const systemPrompt = systemPromptStore.get(ctx.session.id);
    systemPromptStore.delete(ctx.session.id);
    const payload = journal.finalize({
      sessionId: ctx.session.id,
      outcome,
      agentName: ctx.agent?.name ?? "unknown",
      channelKind: ctx.channel?.kind,
      project,
      recordContent,
      now: at,
      anchor,
      systemPrompt,
    });
    if (payload) await client.createRun(payload as unknown as Record<string, unknown>);
  }

  async function capture(kind: FailureKind, subject: string, data: unknown, ctx: HookCtx) {
    if (!client) return; // no key = no-op
    const at = now();
    await client.createRun(
      failureRunPayload({
        kind,
        subject,
        data,
        sessionId: ctx.session.id,
        agentName: ctx.agent?.name ?? "unknown",
        channelKind: ctx.channel?.kind,
        project,
        now: at,
        // Nest inside the request's trace when the anchor is known; fall
        // back to a standalone run when spans are disabled.
        attach: attachmentFor(traceAnchors.get(ctx.session.id), randomUUID(), at),
      }) as unknown as Record<string, unknown>,
    );
  }

  return {
    // --- Turn journal: accumulate the story of the current turn -----------
    "message.received": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.received", event.data, now());
    }),
    "step.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "step.completed", event.data, now());
    }),
    "message.completed": guard(async (event, ctx) => {
      journal.record(ctx.session.id, "message.completed", event.data, now());
    }),
    "turn.completed": guard(async (_event, ctx) => {
      await finalizeTurn("answered", ctx);
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
    }),

    "session.failed": guard(async (event, ctx) => {
      await capture("session", String(event.data?.code ?? "session_error"), event.data, ctx);
    }),
    // Deliberately absent: turn.cancelled — a cancel is not a failure.
  };
}

// Explicit regional apiUrl (EU) via the central factory — never the SDK's US
// default. Undefined without a key, so every handler stays a silent no-op.
const client = createLangsmithClient() as unknown as LangSmithLike | undefined;

export default defineHook({ events: handlersFor(client, projectName()) as never });
