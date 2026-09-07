/**
 * Pins the forward-looking context projection in lib/request-budget.ts.
 *
 * THE FAILURE THIS PREVENTS
 *
 * A three-intent question ("box studio and best swimming pool in Dortmund and
 * is all inclusive included") makes the model call `find_partners` three times
 * in a SINGLE turn. At `finalRecommendations: 100` each result renders ~42k
 * tokens, so the request reached ~141k against gpt-4o-mini's 128k window and
 * Azure rejected all of it with `context_length_exceeded`.
 *
 * Every other budget check looks backwards at work already done, which cannot
 * help here: by the time `step.completed` reports the usage, the oversized
 * request has already been sent and refused. The projection has to run before
 * the call.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REQUEST_BUDGET,
  admitSearches,
  assertBudgetInvariant,
  clearBudget,
  expectedSearchTokens,
  onCompactionCompleted,
  recordRenderedContext,
  recordToolCallStart,
  renderCeilingTokens,
  resetBudget,
  usableContextTokens,
  MAX_SEARCHES_PER_TURN,
  type RequestBudgetLimits,
} from "../lib/request-budget";

const GPT_4O_MINI = 128_000;
const GPT_41 = 1_047_576;

/** A search at the wide-context profile — the measured ~42k tokens. */
const WIDE_SEARCH = expectedSearchTokens(100);

describe("usableContextTokens", () => {
  it("reserves room for the system prompt and the reply", () => {
    // 128,000 - 11,000 prompt - 8,000 output reserve
    expect(usableContextTokens(GPT_4O_MINI)).toBe(109_000);
  });

  it("scales with the deployed model", () => {
    expect(usableContextTokens(GPT_41)).toBeGreaterThan(1_000_000);
  });

  it("never goes negative for an implausibly small window", () => {
    expect(usableContextTokens(1_000)).toBe(0);
  });
});

describe("expectedSearchTokens", () => {
  it("covers the measured payload at finalRecommendations: 100, headers included", () => {
    // 167,456 chars / 4 = 41,864 tokens of profile text measured live, PLUS
    // per-partner headers/separators/disclosure (~30 tok/partner) — R13 §4.5
    // sizes the constant at 450/partner so the estimate can never undercount.
    expect(expectedSearchTokens(100)).toBe(45_000);
    expect(expectedSearchTokens(100)).toBeGreaterThan(41_864);
  });

  it("is linear in the number of profiles rendered", () => {
    expect(expectedSearchTokens(50)).toBeCloseTo(expectedSearchTokens(100) / 2, -1);
    expect(expectedSearchTokens(25)).toBeCloseTo(expectedSearchTokens(100) / 4, -1);
  });
});

describe("recordToolCallStart — context projection", () => {
  const session = "ctx-test";
  /** A 128k model, with the tool-call ceiling raised so the projection is the
   *  only thing that can reject. */
  const limits: RequestBudgetLimits = {
    ...DEFAULT_REQUEST_BUDGET,
    maxToolCalls: 10,
    maxRenderedContextTokens: usableContextTokens(GPT_4O_MINI),
  };

  // Rendered context is CONVERSATION-scoped now (R13 §3.2), so tests must
  // fully clear the session, not just reset the turn.
  beforeEach(() => clearBudget(session));

  it("reproduces the real failure: the THIRD wide search is refused", () => {
    // 42k fits, 84k fits, 126k does not (> 109k usable).
    expect(recordToolCallStart(session, limits, undefined, WIDE_SEARCH).ok).toBe(true);
    recordRenderedContext(session, 167_456);

    expect(recordToolCallStart(session, limits, undefined, WIDE_SEARCH).ok).toBe(true);
    recordRenderedContext(session, 167_456);

    const third = recordToolCallStart(session, limits, undefined, WIDE_SEARCH);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe("context_window");
    expect(third.reason).toMatch(/exceeds the render ceiling/);
  });

  it("gives the context rejection its own code, so the tool can ask a better question", () => {
    // "which activity did you mean?" is right here; "try again" is not.
    recordRenderedContext(session, 4 * usableContextTokens(GPT_4O_MINI));
    const result = recordToolCallStart(session, limits, undefined, WIDE_SEARCH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("context_window");
  });

  it("does not fire on a model with a large window — same config, more room", () => {
    const roomy: RequestBudgetLimits = {
      ...limits,
      maxRenderedContextTokens: usableContextTokens(GPT_41),
    };
    for (let i = 0; i < 5; i++) {
      expect(recordToolCallStart(session, roomy, undefined, WIDE_SEARCH).ok).toBe(true);
      recordRenderedContext(session, 167_456);
    }
  });

  it("a narrower shortlist fits far more searches in the same 128k window", () => {
    const narrow = expectedSearchTokens(25);
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if (!recordToolCallStart(session, limits, undefined, narrow).ok) break;
      recordRenderedContext(session, 25 * 1_675);
      allowed++;
    }
    expect(allowed).toBeGreaterThanOrEqual(8);
  });

  it("is inert when a tool projects nothing (get_partner_details)", () => {
    recordRenderedContext(session, 10_000_000); // far past any window
    // No projection argument => the context check must not run at all; the
    // small, bounded get_partner_details result is always affordable.
    const result = recordToolCallStart(session, limits);
    expect(result.ok).toBe(true);
  });

  // R13 §3.2 (plans/R03): the context those tokens occupy SURVIVES the turn,
  // so the counter must too. It resets only when compaction deletes the tool
  // results, or when the session dies.
  it("survives the turn reset and resets on compaction.completed", () => {
    recordRenderedContext(session, 167_456 * 3);
    expect(recordToolCallStart(session, limits, undefined, WIDE_SEARCH).ok).toBe(false);
    resetBudget(session); // turn boundary — context is still full
    expect(recordToolCallStart(session, limits, undefined, WIDE_SEARCH).ok).toBe(false);
    onCompactionCompleted(session); // eve deleted the tool results
    expect(recordToolCallStart(session, limits, undefined, WIDE_SEARCH).ok).toBe(true);
  });
});

describe("renderCeilingTokens — the compaction invariant (R13 §3.1)", () => {
  it("stays under eve's mid-loop compaction trigger on every window", () => {
    for (const w of [128_000, 200_000, 1_047_576]) {
      expect(() => assertBudgetInvariant(w)).not.toThrow();
      // A conversation that legally fills the ceiling + the prompt must be
      // below window × 0.9, or compaction deletes the turn's own results.
      expect(renderCeilingTokens(w) + 11_000).toBeLessThan(Math.floor(w * 0.9));
    }
  });

  it("is strictly tighter than the old prompt+output bound on 128k", () => {
    // The old 109k ceiling ADMITTED what compaction then destroyed:
    // 109k rendered + 11k prompt = 120k > 115.2k trigger.
    expect(renderCeilingTokens(128_000)).toBeLessThan(usableContextTokens(128_000));
    expect(renderCeilingTokens(128_000)).toBeGreaterThan(60_000);
  });
});

describe("admitSearches — atomic batch admission (R13 §2)", () => {
  const session = "admit-test";
  beforeEach(() => clearBudget(session));

  it("admits at most MAX_SEARCHES_PER_TURN and reserves atomically", () => {
    const a = admitSearches(session, 5);
    expect(a.admitted).toBe(MAX_SEARCHES_PER_TURN);
    expect(a.deferredReason).toBe("concurrency");
    expect(a.allotmentTokens).toBeGreaterThanOrEqual(6_000);
    // A second batch in the same turn gets nothing — the cap is per turn.
    const b = admitSearches(session, 2);
    expect(b.admitted).toBe(0);
  });

  it("shrinks admission when the conversation is near the ceiling", () => {
    // Fill all but ~13k tokens of the ceiling → only 2 × 6k searches fit.
    const ceiling = DEFAULT_REQUEST_BUDGET.maxRenderedContextTokens;
    recordRenderedContext(session, (ceiling - 13_000) * 4);
    const a = admitSearches(session, 3);
    expect(a.admitted).toBe(2);
    expect(a.deferredReason).toBe("budget");
  });

  it("defers everything when no minimum-viable search fits", () => {
    const ceiling = DEFAULT_REQUEST_BUDGET.maxRenderedContextTokens;
    recordRenderedContext(session, (ceiling - 1_000) * 4);
    const a = admitSearches(session, 2);
    expect(a.admitted).toBe(0);
    expect(a.deferredReason).toBe("budget");
  });
});
