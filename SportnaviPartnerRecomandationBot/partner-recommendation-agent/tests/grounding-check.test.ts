import { describe, expect, it } from "vitest";
import { checkGrounding } from "../lib/partners/grounding-check";

describe("checkGrounding", () => {
  it("does not flag when no partners were returned this turn (nothing to ground against)", () => {
    const result = checkGrounding("Hallo! In welcher Stadt suchst du?", []);
    expect(result).toEqual({ flagged: false, suspectNames: [] });
  });

  it("does not flag a reply that only mentions known partner names", () => {
    const reply =
      "Ich empfehle dir das Yoga Studio Nord und Fitness Point Bochum, beide laut Profil sehr beliebt.";
    const result = checkGrounding(reply, ["Yoga Studio Nord", "Fitness Point Bochum"]);
    expect(result.flagged).toBe(false);
  });

  it("flags a Title-Case business-name-shaped span not present in the known set", () => {
    const reply = "Ich empfehle dir das Kletterzentrum Himmelsleiter, laut Profil top bewertet.";
    const result = checkGrounding(reply, ["Yoga Studio Nord"]);
    expect(result.flagged).toBe(true);
    expect(result.suspectNames).toContain("Kletterzentrum Himmelsleiter");
  });

  it("does not flag common German conversational openers", () => {
    const reply = "Hallo Zusammen! Viel Erfolg beim Training mit dem Yoga Studio Nord.";
    const result = checkGrounding(reply, ["Yoga Studio Nord"]);
    expect(result.flagged).toBe(false);
  });

  it("matches case-insensitively and tolerates partial/article-prefixed mentions", () => {
    const reply = "Schau dir das yoga studio nord mal an.";
    const result = checkGrounding(reply, ["Yoga Studio Nord"]);
    expect(result.flagged).toBe(false);
  });

  it("deduplicates repeated suspect spans", () => {
    const reply = "Fabrik Zwo ist toll. Fabrik Zwo hat auch Kurse am Wochenende.";
    const result = checkGrounding(reply, ["Yoga Studio Nord"]);
    expect(result.suspectNames).toEqual(["Fabrik Zwo"]);
  });
});
