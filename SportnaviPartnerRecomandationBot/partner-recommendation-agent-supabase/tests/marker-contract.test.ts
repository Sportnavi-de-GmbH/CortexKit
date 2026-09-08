/**
 * The marker contract between this prompt and the Navio widget.
 *
 * The widget strips `[[action:…]]` / `[[notice:…]]` out of the reply and renders
 * the rest as buttons and callouts (`kb-agent-langsmith-starter/lib/navio-actions.ts`).
 * An id it does not recognise is DROPPED SILENTLY — no error, no button, and the
 * prose still reads "tap the button below". A typo here is therefore invisible in
 * production and invisible in every eval that only reads the prose.
 *
 * These ids are duplicated from the widget on purpose: the two services deploy
 * separately, so there is nothing to import. Changing one side means changing the
 * other, and this test is the thing that says so out loud.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Must match NAVIO_ACTION_IDS in the widget's lib/navio-actions.ts. */
const WIDGET_ACTION_IDS = [
  "partner",
  "faq-agent",
  "studios",
  "contact",
  "meeting",
  "faq",
  "about",
];
/** Must match NAVIO_NOTICE_IDS in the widget's lib/navio-actions.ts. */
const WIDGET_NOTICE_IDS = ["data"];

const prompt = readFileSync("agent/instructions.md", "utf8");

function markers(kind: "action" | "notice"): string[] {
  const found = [...prompt.matchAll(new RegExp(`\\[\\[${kind}:([a-z0-9_-]+)\\]\\]`, "gi"))];
  return [...new Set(found.map((m) => m[1]))];
}

describe("every marker the prompt teaches is one the widget renders", () => {
  it("uses only known action ids", () => {
    for (const id of markers("action")) expect(WIDGET_ACTION_IDS).toContain(id);
  });

  it("uses only known notice ids", () => {
    for (const id of markers("notice")) expect(WIDGET_NOTICE_IDS).toContain(id);
  });

  it("actually teaches the four buttons this agent needs", () => {
    // Not just "no typos" — the sections could have been dropped wholesale.
    for (const id of ["faq-agent", "studios", "contact", "meeting"]) {
      expect(markers("action")).toContain(id);
    }
    expect(markers("notice")).toContain("data");
  });
});

describe("the behaviours those markers exist for", () => {
  it("tells the agent to hand Sportnavi questions to the FAQ agent", () => {
    expect(prompt).toContain("hand it to the FAQ agent");
    // The hand-off is worthless without the button that performs it.
    expect(prompt).toMatch(/\[\[action:faq-agent\]\][\s\S]{0,400}?first marker/);
  });

  it("keeps the agent out of Sportnavi's own subject matter", () => {
    // The topics it must not answer from memory — same failure class as
    // inventing a studio.
    for (const topic of ["cancellation", "tariffs", "check-in", "cashback"]) {
      expect(prompt.toLowerCase()).toContain(topic);
    }
  });

  it("requires the freshness notice exactly when partners were named", () => {
    expect(prompt).toMatch(/named at least one real partner[\s\S]{0,120}\[\[notice:data\]\]/);
    // …and NOT on a turn with nothing to be stale.
    expect(prompt).toMatch(/names no partner[\s\S]{0,160}leave it out/);
  });

  it("tells the agent to point at the studio for details that change", () => {
    expect(prompt).toContain("Current details always come from the studio itself");
    for (const changeable of ["Opening hours", "prices", "availability"]) {
      expect(prompt).toContain(changeable);
    }
  });

  it("caps the studio caveat at once per message, so it stays readable", () => {
    expect(prompt).toContain("once per message");
  });

  it("does not ask the agent to emit the chip the widget already guarantees", () => {
    // "Studios durchsuchen" is rendered under every answer by the widget; telling
    // the model to emit it too would spend a marker slot for nothing.
    expect(prompt).toContain("never need to emit `[[action:studios]]`");
  });
});
