/**
 * Per-turn budget bookkeeping (production-readiness review items 1/3/6: no
 * ceiling on model steps/tool calls, no request-level budget, no token
 * visibility). eve exposes no `stopWhen`/`maxSteps` and hooks are
 * observe-only — this file ONLY accumulates state into
 * lib/request-budget.ts; it never tries to block or abort anything. The
 * actual enforcement happens synchronously inside each tool's `execute()`
 * (agent/tools/find_partners.ts, agent/tools/get_partner_details.ts) via
 * `recordToolCallStart`, which reads the same state this hook writes.
 *
 * A tool can't see how many model steps have already run in its own turn —
 * only eve's hook stream carries that (`step.completed`) — which is why
 * this bookkeeping has to live in a hook rather than in the tools
 * themselves.
 *
 * IRON RULE: never throw. eve escalates a thrown hook to `turn.failed` (see
 * agent/hooks/sentry.ts and agent/hooks/langsmith.ts, which document and
 * enforce the same rule via their own `guard()` helper). Copied inline here
 * rather than imported — it's four lines and not worth coupling this file
 * to either existing hook module.
 */
import { defineHook } from "eve/hooks";

import { resetBudget, recordModelStep, clearBudget } from "../../lib/request-budget";

type HookHandler = (event: { data?: Record<string, unknown> }, ctx: HookCtx) => Promise<void>;

interface HookCtx {
  session: { id: string };
}

function guard(fn: HookHandler): HookHandler {
  return async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch {
      // Intentionally silent — see IRON RULE above.
    }
  };
}

export function handlersFor(): Record<string, HookHandler> {
  return {
    // A new user message starts a fresh budget window — mirrors
    // lib/langsmith.ts's TurnJournal reset-on-message.received pattern, for
    // the same reason: sessions are multi-turn, and without a reset,
    // counters would accumulate across turns instead of resetting per turn.
    "message.received": guard(async (_event, ctx) => {
      resetBudget(ctx.session.id);
    }),

    "step.completed": guard(async (event, ctx) => {
      const usage = event.data?.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      recordModelStep(ctx.session.id, usage);
    }),

    "turn.completed": guard(async (_event, ctx) => {
      clearBudget(ctx.session.id);
    }),
    "turn.failed": guard(async (_event, ctx) => {
      clearBudget(ctx.session.id);
    }),
    "session.failed": guard(async (_event, ctx) => {
      clearBudget(ctx.session.id);
    }),

    // Deliberately absent: "turn.cancelled" — mirrors agent/hooks/sentry.ts
    // and agent/hooks/langsmith.ts; a cancelled turn isn't a failure, and
    // resetBudget already fires again on the next message.received anyway.
  };
}

export default defineHook({
  events: handlersFor() as never,
});
