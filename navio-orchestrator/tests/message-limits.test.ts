/**
 * The message-length cap, and the promise that the UI and the API enforce the
 * SAME one. The bug this guards against is not "no limit" — it is a limit that
 * the counter reports and the server ignores (or vice versa), which is how a
 * client-side cap turns into a bypass.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_CHARS,
  MESSAGE_COUNTER_VISIBLE_AT,
  TOO_LONG_API_DETAIL,
  extractMessageText,
  isMessageTooLong,
  messageLength,
  nearLimitMessage,
  tooLongMessage,
} from "../lib/message-limits";

const ok = "a".repeat(MAX_MESSAGE_CHARS);
const over = "a".repeat(MAX_MESSAGE_CHARS + 1);

describe("the cap itself", () => {
  it("is a sane positive limit", () => {
    expect(MAX_MESSAGE_CHARS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_MESSAGE_CHARS)).toBe(true);
  });

  it("shows the counter before the limit, not after it is already blown", () => {
    expect(MESSAGE_COUNTER_VISIBLE_AT).toBeGreaterThan(0);
    expect(MESSAGE_COUNTER_VISIBLE_AT).toBeLessThan(MAX_MESSAGE_CHARS);
  });

  it("accepts exactly the limit and rejects one over — the boundary is inclusive", () => {
    expect(isMessageTooLong(ok)).toBe(false);
    expect(isMessageTooLong(over)).toBe(true);
  });

  it("measures the TRIMMED text, so trailing whitespace never blocks a valid send", () => {
    expect(messageLength(`  ${ok}  `)).toBe(MAX_MESSAGE_CHARS);
    expect(isMessageTooLong(`${ok}\n\n   `)).toBe(false);
  });

  it("treats an empty or whitespace-only draft as zero length", () => {
    expect(messageLength("")).toBe(0);
    expect(messageLength("   \n ")).toBe(0);
  });
});

describe("the message shown to the visitor", () => {
  it("says exactly how many characters to remove, so the fix is actionable", () => {
    const msg = tooLongMessage("a".repeat(MAX_MESSAGE_CHARS + 25));
    expect(msg).toContain("25");
  });

  it("offers the chat-shaped way out: send it as two messages", () => {
    expect(tooLongMessage(over)).toMatch(/zwei Nachrichten|two messages/i);
  });

  it("stays friendly — never the words error/invalid/forbidden", () => {
    expect(tooLongMessage(over)).not.toMatch(/error|invalid|forbidden|fehler|ungültig/i);
  });

  it("is bilingual, like the widget's other visitor-facing copy", () => {
    const msg = tooLongMessage(over);
    expect(msg).toMatch(/kürze/i); // German
    expect(msg).toMatch(/trim/i); // English
  });

  it("counts DOWN while there is still room, rather than counting up", () => {
    const msg = nearLimitMessage("a".repeat(MAX_MESSAGE_CHARS - 40));
    expect(msg).toContain("40");
    expect(msg).toMatch(/left/i);
  });

  it("never echoes the visitor's text back in the API detail", () => {
    expect(TOO_LONG_API_DETAIL).not.toContain("a".repeat(20));
    expect(TOO_LONG_API_DETAIL).toContain(String(MAX_MESSAGE_CHARS));
  });
});

describe("extractMessageText", () => {
  it("reads eve's { message } body", () => {
    expect(extractMessageText({ message: "hi" })).toBe("hi");
  });

  it("returns null for anything else, so it never acts as a schema validator", () => {
    expect(extractMessageText(null)).toBeNull();
    expect(extractMessageText("hi")).toBeNull();
    expect(extractMessageText({})).toBeNull();
    expect(extractMessageText({ message: 42 })).toBeNull();
    expect(extractMessageText({ msg: "hi" })).toBeNull();
  });
});

// NOTE (orchestrator): unlike kb-agent there is no /api/partner proxy here — the
// partner call is server-side inside find_partners, so the only public entry is
// /eve/v1/*, guarded by messageLengthLimit() in agent/channels/eve.ts using
// exactly the extractMessageText + isMessageTooLong pair covered above.
