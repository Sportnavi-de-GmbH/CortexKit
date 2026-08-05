import { describe, expect, it } from "vitest";
import {
  resetBudget,
  clearBudget,
  recordModelStep,
  recordKnownNames,
  getBudgetSnapshot,
  recordToolCallStart,
  DEFAULT_REQUEST_BUDGET,
  type RequestBudgetLimits,
} from "../lib/request-budget";

let counter = 0;
function sid(): string {
  counter += 1;
  return `session-${counter}`;
}

describe("recordToolCallStart", () => {
  it("allows the first call and increments the counter", () => {
    const session = sid();
    resetBudget(session);
    const result = recordToolCallStart(session);
    expect(result).toEqual({ ok: true });
    expect(getBudgetSnapshot(session).toolCalls).toBe(1);
  });

  it("rejects once maxToolCalls is reached", () => {
    const session = sid();
    resetBudget(session);
    const limits: RequestBudgetLimits = { ...DEFAULT_REQUEST_BUDGET, maxToolCalls: 2 };
    expect(recordToolCallStart(session, limits)).toEqual({ ok: true });
    expect(recordToolCallStart(session, limits)).toEqual({ ok: true });
    const third = recordToolCallStart(session, limits);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toMatch(/tool-call limit/);
  });

  it("rejects once maxModelSteps has already been reached by prior steps", () => {
    const session = sid();
    resetBudget(session);
    const limits: RequestBudgetLimits = { ...DEFAULT_REQUEST_BUDGET, maxModelSteps: 1 };
    recordModelStep(session, { inputTokens: 10, outputTokens: 5 });
    const result = recordToolCallStart(session, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/model-step limit/);
  });

  it("rejects once the wall-clock budget has elapsed", () => {
    const session = sid();
    let now = 1000;
    resetBudget(session, () => now);
    const limits: RequestBudgetLimits = { ...DEFAULT_REQUEST_BUDGET, maxWallClockMs: 500 };
    now += 600;
    const result = recordToolCallStart(session, limits, () => now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/wall-clock/);
  });

  it("rejects once accumulated tokens exceed the token budget", () => {
    const session = sid();
    resetBudget(session);
    const limits: RequestBudgetLimits = { ...DEFAULT_REQUEST_BUDGET, maxTokensPerTurn: 100 };
    recordModelStep(session, { inputTokens: 80, outputTokens: 30 });
    const result = recordToolCallStart(session, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/token budget/);
  });

  it("rejects once estimated cost exceeds the cost budget", () => {
    const session = sid();
    resetBudget(session);
    const limits: RequestBudgetLimits = { ...DEFAULT_REQUEST_BUDGET, maxEstimatedCostUsd: 0.0001 };
    recordModelStep(session, { inputTokens: 1000, outputTokens: 1000 });
    const result = recordToolCallStart(session, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cost budget/);
  });

  it("a fresh session with no prior resetBudget call still starts from an empty state", () => {
    const session = sid();
    const result = recordToolCallStart(session);
    expect(result).toEqual({ ok: true });
  });
});

describe("resetBudget / clearBudget", () => {
  it("resetBudget wipes prior counters", () => {
    const session = sid();
    recordToolCallStart(session);
    recordToolCallStart(session);
    expect(getBudgetSnapshot(session).toolCalls).toBe(2);
    resetBudget(session);
    expect(getBudgetSnapshot(session).toolCalls).toBe(0);
  });

  it("clearBudget wipes counters the same way", () => {
    const session = sid();
    recordToolCallStart(session);
    clearBudget(session);
    expect(getBudgetSnapshot(session).toolCalls).toBe(0);
  });
});

describe("recordModelStep", () => {
  it("accumulates tokens and step count across multiple calls", () => {
    const session = sid();
    resetBudget(session);
    recordModelStep(session, { inputTokens: 100, outputTokens: 50 });
    recordModelStep(session, { inputTokens: 200, outputTokens: 20 });
    const snapshot = getBudgetSnapshot(session);
    expect(snapshot.modelSteps).toBe(2);
    expect(snapshot.inputTokens).toBe(300);
    expect(snapshot.outputTokens).toBe(70);
    expect(snapshot.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("treats missing usage fields as zero rather than throwing", () => {
    const session = sid();
    resetBudget(session);
    expect(() => recordModelStep(session, undefined)).not.toThrow();
    expect(getBudgetSnapshot(session).modelSteps).toBe(1);
  });
});

describe("recordKnownNames", () => {
  it("accumulates names across multiple calls within a turn", () => {
    const session = sid();
    resetBudget(session);
    recordKnownNames(session, ["Studio A", "Studio B"]);
    recordKnownNames(session, ["Studio C"]);
    expect(getBudgetSnapshot(session).knownPartnerNames).toEqual(["Studio A", "Studio B", "Studio C"]);
  });

  it("is cleared by resetBudget", () => {
    const session = sid();
    recordKnownNames(session, ["Studio A"]);
    resetBudget(session);
    expect(getBudgetSnapshot(session).knownPartnerNames).toEqual([]);
  });
});
