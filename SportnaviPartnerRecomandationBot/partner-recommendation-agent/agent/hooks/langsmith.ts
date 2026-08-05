/**
 * ERROR + SUMMARY CAPTURE for LangSmith. Eve reports failures as stream
 * events, never exceptions (agent/hooks/sentry.ts documents the same fact,
 * and this hook mirrors its shape), so trace export alone
 * (agent/instrumentation.ts) captures zero failures and every trace-list row
 * would read "No inputs / No outputs" — the OTLP root is a workflow-
 * infrastructure span with no conversation IO on it. This hook is the only
 * path from an agent failure to a LangSmith run, and the only place the
 * user's message / the agent's reply / the assembled system prompt land on
 * a run. See EVE_LANGSMITH_TRACING_GUIDE.md Parts B and D.
 *
 * IRON RULE: never throw. eve escalates a thrown hook to `turn.failed`, and
 * a throw inside a failure-cascade handler to `session.failed`
 * (node_modules/eve/docs/guides/hooks.md). Every handler goes through `guard`.
 *
 * PRIVACY: content (user message, reply, system prompt) is included only
 * when LANGSMITH_RECORD_IO=true; otherwise only timing/token/tool counts and
 * the outcome are sent. See lib/langsmith.ts.
 */
import { defineHook } from "eve/hooks";

import { randomUUID } from "node:crypto";

import {
  childAttachment,
  createLangsmithClient,
  failureRunPayload,
  projectName,
  recordIo,
  systemPromptStore,
  traceAnchors,
  TurnJournal,
  type FailureKind,
  type LangSmithRunPayload,
} from "../../lib/langsmith";

/** The one Client method the hook needs, injectable for tests. */
export interface LangSmithLike {
  createRun(payload: LangSmithRunPayload): Promise<unknown>;
}

type HookHandler = (event: { data?: Record<string, unknown> }, ctx: HookCtx) => Promise<void>;

interface HookCtx {
  agent: { name: string };
  channel?: { kind?: string };
  session: { id: string };
}

/** Swallow everything. Observability failing must never become an agent failure. */
function guard(fn: HookHandler): HookHandler {
  return async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch {
      // Intentionally silent — eve treats any throw from a hook as a real
      // turn failure.
    }
  };
}

export function handlersFor(
  client: LangSmithLike | undefined,
  project: string,
  journal: TurnJournal = new TurnJournal(),
  opts: { recordContent?: boolean; now?: () => number } = {},
): Record<string, HookHandler> {
  const now = opts.now ?? Date.now;
  const recordContent = opts.recordContent ?? recordIo();

  async function finalizeTurn(outcome: "answered" | "failed", ctx: HookCtx) {
    if (!client) return; // no key = no-op
    const systemPrompt = recordContent ? systemPromptStore.get(ctx.session.id) : undefined;
    // Part C: the anchor was published by the span filter when this turn's
    // `eve.turn` span started. Taking it here makes this summary run the ROOT
    // of the OTLP trace, so the request's IO and its token/cost rollup end up
    // in ONE trace instead of two disconnected ones.
    const anchor = traceAnchors.get(ctx.session.id);
    const payload = journal.finalize({
      sessionId: ctx.session.id,
      outcome,
      agentName: ctx.agent?.name ?? "unknown",
      channelKind: ctx.channel?.kind,
      project,
      recordContent,
      systemPrompt,
      anchor,
      now: now(),
    });
    systemPromptStore.delete(ctx.session.id);
    traceAnchors.delete(ctx.session.id);
    if (payload) await client.createRun(payload);
  }

  async function capture(kind: FailureKind, subject: string, data: unknown, ctx: HookCtx) {
    if (!client) return;
    const at = now();
    // Failure runs nest under the same root. Read-only here — the anchor is
    // consumed by finalizeTurn at turn end, and a tool can fail mid-turn.
    const anchor = traceAnchors.get(ctx.session.id);
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
        attach: childAttachment(anchor, randomUUID(), at),
      }),
    );
  }

  return {
    // --- Turn journal: accumulate the story of the current turn ----------
    "message.received": guard(async (e, ctx) =>
      journal.record(ctx.session.id, "message.received", e.data, now()),
    ),
    "step.completed": guard(async (e, ctx) =>
      journal.record(ctx.session.id, "step.completed", e.data, now()),
    ),
    "message.completed": guard(async (e, ctx) =>
      journal.record(ctx.session.id, "message.completed", e.data, now()),
    ),
    // Fallback source for the reply: `message.completed.data.message` is typed
    // `string | null`, and turns were observed live landing a summary run with
    // no `agent_reply` at all. `messageSoFar` always carries the text.
    "message.appended": guard(async (e, ctx) =>
      journal.record(ctx.session.id, "message.appended", e.data, now()),
    ),
    // A turn can end by ASKING rather than answering (eve's built-in
    // `ask_question` tool). Such a turn emits no assistant text block at all,
    // so without this the summary run has no output and is mislabelled
    // "answered" — observed live on "best yoga studio" (no city given).
    "input.requested": guard(async (e, ctx) =>
      journal.record(ctx.session.id, "input.requested", e.data, now()),
    ),
    "turn.completed": guard(async (_e, ctx) => finalizeTurn("answered", ctx)),

    // --- Failure capture ---------------------------------------------------
    "action.result": guard(async (e, ctx) => {
      journal.record(ctx.session.id, "action.result", e.data, now());
      const result = e.data?.result as
        | { isError?: boolean; toolName?: string; output?: unknown }
        | undefined;
      if (!result?.isError) return; // successes are already on the OTel trace
      await capture("tool", result.toolName ?? "unknown_tool", result.output, ctx);
    }),
    "step.failed": guard(async (e, ctx) =>
      capture("step", String(e.data?.code ?? "step_error"), e.data, ctx),
    ),
    "turn.failed": guard(async (e, ctx) => {
      await capture("turn", String(e.data?.code ?? "turn_error"), e.data, ctx);
      await finalizeTurn("failed", ctx);
    }),
    "session.failed": guard(async (e, ctx) =>
      capture("session", String(e.data?.code ?? "session_error"), e.data, ctx),
    ),

    // Deliberately absent: "turn.cancelled" — mirrors agent/hooks/sentry.ts;
    // a cancelled turn is not a failure and would alert/log on every stop click.
  };
}

const client = createLangsmithClient();
export default defineHook({
  events: handlersFor(client, projectName()) as never,
});
