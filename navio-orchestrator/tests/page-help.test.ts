/**
 * The page-specific help manual (components/navio/PageHelp.tsx).
 *
 * Ported from kb-agent-langsmith-starter. The product requirement these tests
 * pin, adapted to the chat-first design: this widget has ONE page, so its ⓘ
 * manual must describe everything that one chat can do — general questions,
 * the city-based partner search, and the contact/booking buttons — in German
 * AND English, mirrored line for line.
 */
import { describe, expect, it } from "vitest";

import { PAGE_HELP } from "../components/navio/pageHelpContent";

describe("PAGE_HELP contract", () => {
  it("covers exactly the one screen that has a manual", () => {
    expect(Object.keys(PAGE_HELP)).toEqual(["chat"]);
  });

  it("is bilingual with non-empty, line-mirrored content", () => {
    const h = PAGE_HELP.chat;
    expect(h.title.trim()).not.toBe("");
    expect(h.de.length).toBeGreaterThan(0);
    for (const line of [...h.de, ...h.en]) expect(line.trim()).not.toBe("");
    // The DE/EN blocks mirror each other line for line, so neither language
    // silently falls behind when the copy is edited.
    expect(h.en.length).toBe(h.de.length);
  });

  it("says: general questions, any language", () => {
    const text = PAGE_HELP.chat.de.join(" ") + " " + PAGE_HELP.chat.en.join(" ");
    expect(text).toMatch(/allgemeine Fragen/i);
    expect(text).toMatch(/jeder Sprache/i);
    expect(text).toMatch(/any language/i);
  });

  it("says: partner search needs a city, with a concrete example", () => {
    const de = PAGE_HELP.chat.de.join(" ");
    const en = PAGE_HELP.chat.en.join(" ");
    expect(de).toMatch(/Stadt/);
    expect(en).toMatch(/city/i);
    expect(de + en).toMatch(/Yoga in Bochum/i); // a concrete example, not just rules
    expect(en).toMatch(/city-specific/i);
  });

  it("names the team-contact paths the chip row guarantees", () => {
    const text = PAGE_HELP.chat.de.join(" ") + " " + PAGE_HELP.chat.en.join(" ");
    for (const needle of ["Kontaktformular", "Termin"]) expect(text).toContain(needle);
  });
});
