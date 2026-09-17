import { describe, expect, it } from "vitest";
import { detectReplyLanguage, messageTextOf, replyLanguageHint } from "../lib/reply-language";

describe("detectReplyLanguage", () => {
  it("recognises the English turns that production answered in German", () => {
    expect(detectReplyLanguage("Tell me about the prices")).toBe("en");
    expect(detectReplyLanguage("Why should I use Sportnavi?")).toBe("en");
    expect(detectReplyLanguage("And how do I check in at a studio?")).toBe("en");
    expect(detectReplyLanguage("Can I use it on weekends?")).toBe("en");
  });

  it("recognises German, including via umlauts", () => {
    expect(detectReplyLanguage("Warum sollte ich Sportnavi nutzen?")).toBe("de");
    expect(detectReplyLanguage("Wie funktioniert der Check-in?")).toBe("de");
    expect(detectReplyLanguage("Was kostet Sportnavi für mich als Mitarbeiter?")).toBe("de");
    expect(detectReplyLanguage("Kündigung möglich?")).toBe("de");
  });

  it("stays neutral on other languages and on ambiguous input", () => {
    expect(detectReplyLanguage("Comment fonctionne Sportnavi ?")).toBe("unknown");
    expect(detectReplyLanguage("¿Cuánto cuesta Sportnavi?")).toBe("unknown");
    expect(detectReplyLanguage("Bochum")).toBe("unknown");
    expect(detectReplyLanguage("👍")).toBe("unknown");
    expect(detectReplyLanguage("")).toBe("unknown");
  });

  it("does not let a brand or city name tip the balance", () => {
    expect(detectReplyLanguage("Sportnavi Bielefeld")).toBe("unknown");
  });
});

describe("messageTextOf", () => {
  it("passes strings through and joins text parts", () => {
    expect(messageTextOf("hi")).toBe("hi");
    expect(messageTextOf([{ type: "text", text: "Tell me" }, { type: "file", url: "x" }, { type: "text", text: "more" }])).toBe("Tell me\nmore");
    expect(messageTextOf(undefined)).toBe("");
  });
});

describe("replyLanguageHint", () => {
  it("gives an English note for English, a German note for German, a neutral one otherwise", () => {
    expect(replyLanguageHint("Tell me about the prices")).toMatch(/in ENGLISH/);
    expect(replyLanguageHint("Warum sollte ich Sportnavi nutzen?")).toMatch(/auf DEUTSCH/);
    expect(replyLanguageHint("Comment fonctionne Sportnavi ?")).toMatch(/same language/);
  });

  it("always protects the action markers and flags itself as not from the visitor", () => {
    for (const m of ["Tell me about the prices", "Wie geht das?", "Hola"]) {
      const h = replyLanguageHint(m);
      expect(h).toMatch(/\[\[action:\.\.\.\]\]/);
      expect(h).toMatch(/not written by the visitor|nicht vom Besucher/);
    }
  });
});
