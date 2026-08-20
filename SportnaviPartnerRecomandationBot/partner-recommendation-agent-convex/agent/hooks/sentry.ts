/**
 * The failure bridge: eve reports failures as stream events, NEVER as thrown
 * exceptions, so Sentry's automatic error capture cannot see them. Without
 * this hook a failing tool, a dead turn, or a Supabase outage is invisible in
 * Sentry — traces keep flowing and the dashboard looks healthy. This hook is
 * the only path from an agent failure to a Sentry issue.
 *
 * IRON RULE: never throw. eve escalates a thrown hook to `turn.failed`, and a
 * throw inside a failure-cascade handler to `session.failed`
 * (node_modules/eve/docs/guides/hooks.md). Every handler goes through `guard`.
 *
 * PRIVACY: no user text, partner names, or PII is forwarded — only error
 * messages, tool names, codes, and session ids. See lib/sentry-agent.ts.
 */
import * as Sentry from "@sentry/node";
import { defineHook } from "eve/hooks";

import {
  classify,
  severityFor,
  fingerprintFor,
  labelFor,
  titleFor,
  type FailureClass,
  type SubjectKind,
} from "../../lib/sentry-agent";
import { getBudgetSnapshot } from "../../lib/request-budget";
import { checkGrounding } from "../../lib/partners/grounding-check";

/** Narrow Sentry surface so tests can inject a fake without a DSN. */
export interface SentryLike {
  captureException(error: unknown, options?: Record<string, unknown>): string;
  captureMessage(message: string, options?: Record<string, unknown>): string;
  setConversationId(id: string | null): void;
  setUser(user: Record<string, unknown> | null): void;
  addBreadcrumb(breadcrumb: Record<string, unknown>): void;
  setTag(key: string, value: unknown): void;
}

type HookHandler = (event: { data?: Record<string, unknown> }, ctx: HookCtx) => Promise<void>;

interface HookCtx {
  agent: { name: string };
  channel?: { kind?: string };
  session: { id: string };
}

/**
 * Swallow everything. Observability failing must never become an agent
 * failure.
 */
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

/**
 * eve failure payloads come in two shapes; Sentry renders real Error objects
 * far better, so rebuild one:
 *   - turn/step/session failures carry `{ code, message, details? }` (object)
 *   - a thrown tool's `action.result.output` is often the raw message (string)
 */
function toError(data: unknown, fallback: string): Error {
  if (typeof data === "string" && data.trim() !== "") {
    return new Error(data);
  }
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  const message = typeof obj?.message === "string" ? obj.message : fallback;
  const error = new Error(message);
  if (typeof obj?.code === "string") error.name = obj.code;
  return error;
}

export function handlersFor(sentry: SentryLike): Record<string, HookHandler> {
  function captureFailure(
    error: unknown,
    failureClass: FailureClass,
    subjectKind: SubjectKind,
    subject: string,
    tags: Record<string, string>,
    ctx: HookCtx,
  ) {
    const cause = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      error.message = titleFor(failureClass, subjectKind, subject, cause);
    }
    sentry.captureException(error, {
      level: severityFor(failureClass),
      fingerprint: fingerprintFor(failureClass, subject),
      tags: {
        "eve.component": "agent",
        "eve.channel": ctx.channel?.kind ?? "unknown",
        "failure.class": failureClass,
        "failure.label": labelFor(failureClass),
        ...tags,
      },
      extra: { sessionId: ctx.session.id, agent: ctx.agent?.name },
    });
  }

  return {
    "session.started": guard(async (_event, ctx) => {
      sentry.setConversationId(ctx.session.id);
      sentry.setTag("eve.channel", ctx.channel?.kind ?? "unknown");
      sentry.setTag("eve.component", "agent");
    }),

    "action.result": guard(async (event, ctx) => {
      const result = event.data?.result as
        | { isError?: boolean; toolName?: string; output?: unknown }
        | undefined;
      if (!result) return;

      const toolName = result.toolName ?? "unknown_tool";

      if (!result.isError) {
        sentry.addBreadcrumb({
          category: "eve.tool",
          message: `tool '${toolName}' succeeded`,
          level: "info",
          data: { sessionId: ctx.session.id },
        });
        return;
      }

      const error = toError(result.output, `Tool ${toolName} failed`);
      captureFailure(error, classify(result.output), "tool", toolName, { tool: toolName }, ctx);
    }),

    "step.failed": guard(async (event, ctx) => {
      const code = String(event.data?.code ?? "step_error");
      captureFailure(
        toError(event.data, "A model step failed"),
        // A failed model step is an upstream provider problem far more often
        // than an agent-logic problem.
        "external",
        "model step",
        code,
        { "eve.step.code": code },
        ctx,
      );
    }),

    // LIVE grounding tripwire (production-readiness review item 4): flags a
    // reply that names a partner-shaped span this turn's find_partners call
    // never returned. Alert-only — hooks cannot edit or withhold the
    // outgoing message (see lib/partners/grounding-check.ts for the full
    // rationale and its documented limitations). PRIVACY: the suspect
    // names themselves are never sent to Sentry, only a count — the same
    // "no partner names forwarded" rule this file's header already states.
    "message.completed": guard(async (event, ctx) => {
      const data = event.data as { message?: unknown; text?: unknown; content?: unknown } | undefined;
      const replyText = data?.message ?? data?.text ?? data?.content;
      if (typeof replyText !== "string" || replyText.trim() === "") return;

      const knownNames = getBudgetSnapshot(ctx.session.id).knownPartnerNames;
      const result = checkGrounding(replyText, knownNames);
      if (!result.flagged) return;

      sentry.captureMessage(
        titleFor("fabrication", "turn", "reply", `${result.suspectNames.length} unverified name(s)`),
        {
          level: severityFor("fabrication"),
          fingerprint: fingerprintFor("fabrication", "reply_grounding"),
          tags: {
            "eve.component": "agent",
            "eve.channel": ctx.channel?.kind ?? "unknown",
            "failure.class": "fabrication",
            "failure.label": labelFor("fabrication"),
          },
          extra: {
            sessionId: ctx.session.id,
            agent: ctx.agent?.name,
            suspectCount: result.suspectNames.length,
          },
        },
      );
    }),

    "turn.completed": guard(async (_event, ctx) => {
      sentry.addBreadcrumb({
        category: "eve.turn",
        message: "agent turn completed",
        level: "info",
        data: { sessionId: ctx.session.id },
      });
    }),

    "turn.failed": guard(async (event, ctx) => {
      const code = String(event.data?.code ?? "turn_error");
      captureFailure(
        toError(event.data, "The turn failed"),
        "agent",
        "turn",
        code,
        { "eve.turn.code": code },
        ctx,
      );
    }),

    "session.failed": guard(async (event, ctx) => {
      const code = String(event.data?.code ?? "session_error");
      captureFailure(
        toError(event.data, "The session failed"),
        "agent",
        "session",
        code,
        { "eve.session.code": code },
        ctx,
      );
    }),

    // Deliberately absent: "turn.cancelled" — a cancelled turn is not a
    // failure; capturing it would alert on every user stop click.
  };
}

export default defineHook({
  events: handlersFor(Sentry as unknown as SentryLike) as never,
});
