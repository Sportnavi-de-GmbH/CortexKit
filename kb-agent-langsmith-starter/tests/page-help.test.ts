/**
 * The page-specific help manuals (components/navio/PageHelp.tsx).
 *
 * The product requirement these tests pin: the ⓘ explains ONLY the page the
 * visitor is on, in German AND English, and each page's manual states that
 * page's actual purpose — FAQ = general questions in any language, Partner =
 * city-based partner search, Menu = what the menu's options do.
 */
import { describe, expect, it } from "vitest";

import { PAGE_HELP } from "../components/navio/pageHelpContent";

const SCREENS = ["menu", "chat", "partner"] as const;

describe("PAGE_HELP contract", () => {
  it("covers exactly the three screens that have a manual", () => {
    expect(Object.keys(PAGE_HELP).sort()).toEqual([...SCREENS].sort());
  });

  it.each(SCREENS)("%s is bilingual with non-empty content", (s) => {
    const h = PAGE_HELP[s];
    expect(h.title.trim()).not.toBe("");
    expect(h.de.length).toBeGreaterThan(0);
    expect(h.en.length).toBeGreaterThan(0);
    for (const line of [...h.de, ...h.en]) expect(line.trim()).not.toBe("");
    // The DE/EN blocks mirror each other line for line, so neither language
    // silently falls behind when the copy is edited.
    expect(h.en.length).toBe(h.de.length);
  });

  it("FAQ help says: general questions, any language", () => {
    const text = PAGE_HELP.chat.de.join(" ") + " " + PAGE_HELP.chat.en.join(" ");
    expect(text).toMatch(/allgemeine Fragen/i);
    expect(text).toMatch(/jeder Sprache/i);
    expect(text).toMatch(/any language/i);
  });

  it("Partner help says: city + what you seek, and that search is city-specific", () => {
    const de = PAGE_HELP.partner.de.join(" ");
    const en = PAGE_HELP.partner.en.join(" ");
    expect(de).toMatch(/Stadt/);
    expect(en).toMatch(/city/i);
    expect(de + en).toMatch(/Yoga in Bochum/i); // a concrete example, not just rules
    expect(en).toMatch(/city-specific/i);
  });

  it("Menu help names every menu option", () => {
    const text = PAGE_HELP.menu.de.join(" ") + " " + PAGE_HELP.menu.en.join(" ");
    for (const needle of ["FAQ", "Partner", "Kontaktformular", "Termin", "sportnavi.de"]) {
      expect(text).toContain(needle);
    }
  });

  it("no manual mentions another page's feature as its own purpose", () => {
    // FAQ help must not pitch city search; Partner help must not pitch
    // general Q&A — the whole point is page-specificity.
    expect(PAGE_HELP.chat.de.join(" ")).not.toMatch(/Partner finden|Stadt/);
    expect(PAGE_HELP.partner.de.join(" ")).not.toMatch(/allgemeine Fragen|Tarife/);
  });
});
