/**
 * The early-answer preview's event contract (lib/specialist-preview.ts).
 *
 * The failure that matters is silent: a shape mismatch means no preview, the
 * visitor just stares at typing dots for the relay's full duration, and nothing
 * errors anywhere. These tests pin the wire shapes the module relies on
 * (verified against eve dist/src/runtime/actions/types.d.ts and
 * dist/src/protocol/message.d.ts, eve 0.25.x).
 */
import { describe, expect, it } from "vitest";

import {
  childTextDeltaFrom,
  currentTurnDelegationFrom,
  faqChildSessionFrom,
  isChildBoundary,
  previewFragmentFrom,
} from "../lib/specialist-preview";

describe("faqChildSessionFrom", () => {
  it("extracts the child session id from a faq subagent.called", () => {
    expect(
      faqChildSessionFrom({
        type: "subagent.called",
        data: { name: "faq", toolName: "faq", childSessionId: "ses_child1", turnId: "t1" },
      }),
    ).toBe("ses_child1");
  });

  it("ignores other subagents, other events, and missing ids", () => {
    expect(
      faqChildSessionFrom({ type: "subagent.called", data: { name: "other", childSessionId: "x" } }),
    ).toBeNull();
    expect(faqChildSessionFrom({ type: "action.result", data: { name: "faq" } })).toBeNull();
    expect(faqChildSessionFrom({ type: "subagent.called", data: { name: "faq" } })).toBeNull();
  });
});

describe("previewFragmentFrom", () => {
  it("lifts a successful find_partners answer, keyed by call", () => {
    const fragment = previewFragmentFrom({
      type: "action.result",
      data: {
        result: {
          kind: "tool-result",
          callId: "call_1",
          toolName: "find_partners",
          output: { ok: true, answer: "1. Yogahaus Bochum …", searchPerformed: true },
        },
        turnId: "t1",
      },
    });
    expect(fragment).toEqual({ key: "partner:call_1", text: "1. Yogahaus Bochum …" });
  });

  it("ignores a failed search — an error must never render as an answer", () => {
    expect(
      previewFragmentFrom({
        type: "action.result",
        data: {
          result: {
            kind: "tool-result",
            callId: "c",
            toolName: "find_partners",
            output: { ok: false, error: "host unreachable" },
          },
        },
      }),
    ).toBeNull();
  });

  it("lifts a faq subagent result (string or common object fields)", () => {
    const base = { kind: "subagent-result", callId: "c2", subagentName: "faq" };
    expect(
      previewFragmentFrom({ type: "action.result", data: { result: { ...base, output: "Antwort." } } }),
    ).toEqual({ key: "faq:c2", text: "Antwort." });
    expect(
      previewFragmentFrom({
        type: "action.result",
        data: { result: { ...base, output: { text: "Antwort aus Feld." } } },
      }),
    ).toEqual({ key: "faq:c2", text: "Antwort aus Feld." });
  });

  it("ignores other tools and other subagents", () => {
    expect(
      previewFragmentFrom({
        type: "action.result",
        data: {
          result: { kind: "tool-result", callId: "c", toolName: "provide_booking_link", output: { ok: true } },
        },
      }),
    ).toBeNull();
    expect(
      previewFragmentFrom({
        type: "action.result",
        data: { result: { kind: "subagent-result", callId: "c", subagentName: "other", output: "x" } },
      }),
    ).toBeNull();
  });
});

describe("child stream events", () => {
  it("reads assistant text deltas", () => {
    expect(
      childTextDeltaFrom({ type: "message.appended", data: { messageDelta: "Der Check-in " } }),
    ).toBe("Der Check-in ");
    expect(childTextDeltaFrom({ type: "message.appended", data: {} })).toBeNull();
    expect(childTextDeltaFrom({ type: "message.completed", data: { message: "x" } })).toBeNull();
  });

  it("recognizes every terminal boundary", () => {
    for (const type of ["session.waiting", "session.completed", "session.failed", "turn.failed", "turn.cancelled"]) {
      expect(isChildBoundary({ type })).toBe(true);
    }
    expect(isChildBoundary({ type: "message.appended" })).toBe(false);
  });
});

describe("currentTurnDelegationFrom — the UI-side R2 fallback", () => {
  const userMsg = { type: "message.received", data: { message: "…" } };
  const partnerCall = {
    type: "actions.requested",
    data: { actions: [{ name: "find_partners" }], turnId: "t" },
  };
  const faqCall = { type: "subagent.called", data: { name: "faq", childSessionId: "c" } };

  it("sees a partner delegation in the current turn", () => {
    expect(currentTurnDelegationFrom([userMsg, partnerCall])).toBe("partner");
  });

  it("sees a faq delegation, and partner wins for the copy when both fire", () => {
    expect(currentTurnDelegationFrom([userMsg, faqCall])).toBe("faq");
    expect(currentTurnDelegationFrom([userMsg, faqCall, partnerCall])).toBe("partner");
  });

  it("ignores delegations from PREVIOUS turns — a new user message resets the scan", () => {
    expect(currentTurnDelegationFrom([userMsg, partnerCall, userMsg])).toBeNull();
  });

  it("reports nothing before any delegation happened", () => {
    expect(currentTurnDelegationFrom([userMsg])).toBeNull();
    expect(currentTurnDelegationFrom([])).toBeNull();
  });
});
