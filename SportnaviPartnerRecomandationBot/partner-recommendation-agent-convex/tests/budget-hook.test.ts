import { describe, expect, it } from "vitest";
import { handlersFor } from "../agent/hooks/budget";
import { getBudgetSnapshot, recordToolCallStart } from "../lib/request-budget";

let counter = 0;
function ctxFor() {
  counter += 1;
  return { session: { id: `budget-hook-session-${counter}` } };
}

describe("agent/hooks/budget", () => {
  it("resets the budget on message.received", async () => {
    const ctx = ctxFor();
    recordToolCallStart(ctx.session.id);
    expect(getBudgetSnapshot(ctx.session.id).toolCalls).toBe(1);

    await handlersFor()["message.received"]({ data: {} }, ctx);
    expect(getBudgetSnapshot(ctx.session.id).toolCalls).toBe(0);
  });

  it("accumulates usage on step.completed", async () => {
    const ctx = ctxFor();
    await handlersFor()["message.received"]({ data: {} }, ctx);
    await handlersFor()["step.completed"](
      { data: { usage: { inputTokens: 120, outputTokens: 40 } } },
      ctx,
    );
    const snapshot = getBudgetSnapshot(ctx.session.id);
    expect(snapshot.modelSteps).toBe(1);
    expect(snapshot.inputTokens).toBe(120);
    expect(snapshot.outputTokens).toBe(40);
  });

  it("survives a step.completed event with no usage payload", async () => {
    const ctx = ctxFor();
    await expect(handlersFor()["step.completed"]({ data: {} }, ctx)).resolves.toBeUndefined();
  });

  it("clears the budget on turn.completed / turn.failed / session.failed", async () => {
    for (const event of ["turn.completed", "turn.failed", "session.failed"] as const) {
      const ctx = ctxFor();
      recordToolCallStart(ctx.session.id);
      await handlersFor()[event]({ data: {} }, ctx);
      expect(getBudgetSnapshot(ctx.session.id).toolCalls).toBe(0);
    }
  });

  it("never throws even if the underlying budget call would (iron rule)", async () => {
    const ctx = ctxFor();
    const handlers = handlersFor();
    for (const name of Object.keys(handlers)) {
      await expect(handlers[name]({ data: undefined }, ctx)).resolves.toBeUndefined();
    }
  });
});
