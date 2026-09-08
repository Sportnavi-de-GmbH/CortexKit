/**
 * The marker contract between the two agent prompts and the chat bubble.
 *
 * Three failures matter here and none of them is loud: a marker that survives into
 * the rendered text (the visitor reads `[[action:contact]]`), a marker that is
 * silently swallowed without producing its button (the visitor is told to "tap the
 * button below" and there is none), and a guaranteed chip that a chatty answer
 * pushed off the end of the row.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALWAYS_ACTIONS,
  NAVIO_ACTION_IDS,
  parseMessageActions,
  resolveActions,
} from "../lib/navio-actions";

describe("the happy path the prompts actually produce", () => {
  it("lifts the trailing marker line into actions and leaves clean prose", () => {
    const { text, actions } = parseMessageActions(
      "Firmenfitness kostet **59,90 €** pro Monat.\n\n" +
        "[[action:contact]] [[action:meeting]] [[action:faq]]",
    );

    expect(text).toBe("Firmenfitness kostet **59,90 €** pro Monat.");
    expect(actions).toEqual(["contact", "meeting", "faq"]);
  });

  it("keeps the agent's ordering, so its own hand-off stays first", () => {
    const { actions } = parseMessageActions(
      "Das beantwortet dir der FAQ-Agent.\n\n[[action:faq-agent]] [[action:contact]]",
    );
    expect(actions).toEqual(["faq-agent", "contact"]);
  });

  it("returns nothing and untouched text when the agent emits no markers", () => {
    const raw = "Kurze Rückfrage: meinst du deinen Tarif oder deinen Arbeitgeber?";
    expect(parseMessageActions(raw)).toEqual({ text: raw, actions: [], notices: [] });
  });
});

describe("no marker ever reaches the visitor", () => {
  it("strips a marker the model inlined mid-sentence, despite the prompt", () => {
    const { text, actions } = parseMessageActions("Schreib uns [[action:contact]] gern jederzeit.");
    expect(text).toBe("Schreib uns  gern jederzeit.");
    expect(text).not.toContain("[[");
    expect(actions).toEqual(["contact"]);
  });

  it("strips an unknown id instead of rendering it as text", () => {
    const { text, actions } = parseMessageActions("Hilfe gefällig?\n\n[[action:teleport]]");
    expect(text).toBe("Hilfe gefällig?");
    expect(actions).toEqual([]);
  });

  it("accepts a marker the model capitalised", () => {
    expect(parseMessageActions("Text\n\n[[Action:Contact]]").actions).toEqual(["contact"]);
  });
});

describe("streaming — the half-written marker must not flicker", () => {
  // Each prefix is what the bubble holds for one render tick while the last
  // line arrives token by token.
  const prefixes = ["[", "[[", "[[a", "[[action", "[[action:", "[[action:cont", "[[notice:"];

  it.each(prefixes)("hides the partial marker %j at the end of the stream", (partial) => {
    const { text, actions, notices } = parseMessageActions(`Deine Antwort.\n\n${partial}`);
    expect(text).toBe(partial === "[" ? "Deine Antwort.\n\n[" : "Deine Antwort.");
    expect(actions).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("resolves to the real chip once the marker closes", () => {
    expect(parseMessageActions("Deine Antwort.\n\n[[action:contact]]").actions).toEqual(["contact"]);
  });

  it("leaves a bracket in the middle of the text alone", () => {
    const raw = "Siehe [1] und den Hinweis [wichtig] unten.";
    expect(parseMessageActions(raw).text).toBe(raw);
  });
});

describe("parsing bounds", () => {
  it("never repeats a chip the model emitted twice", () => {
    const { actions } = parseMessageActions("Text\n\n[[action:contact]] [[action:contact]]");
    expect(actions).toEqual(["contact"]);
  });

  it("every advertised id is parseable — the prompts list exactly these", () => {
    for (const id of NAVIO_ACTION_IDS) {
      expect(parseMessageActions(`x\n\n[[action:${id}]]`).actions).toEqual([id]);
    }
  });
});

describe("the chips that are always there", () => {
  // "Über uns" and "Studios durchsuchen" are product requirements, and a prompt
  // rule alone cannot promise "always" — a model skips an instruction now and then
  // and the miss is invisible.
  it("adds the FAQ screen's about chip when the agent forgot it", () => {
    expect(resolveActions(["contact", "meeting", "faq"], "faq")).toEqual([
      "contact",
      "meeting",
      "faq",
      "about",
    ]);
  });

  it("adds both partner-screen chips when the agent forgot them", () => {
    expect(resolveActions(["faq-agent", "contact"], "partner")).toEqual([
      "faq-agent",
      "contact",
      "studios",
      "about",
    ]);
  });

  it("shows them even on an answer that asked for nothing", () => {
    expect(resolveActions([], "faq")).toEqual(["about"]);
    expect(resolveActions([], "partner")).toEqual(["studios", "about"]);
  });

  it("does not duplicate one the agent did emit, and keeps it in its fixed slot", () => {
    // Guaranteed chips always trail, wherever the agent put them, so the row ends
    // the same way on every answer instead of shuffling under the reader.
    expect(resolveActions(["studios", "contact"], "partner")).toEqual([
      "contact",
      "studios",
      "about",
    ]);
  });

  it("keeps the agent's most relevant step leftmost", () => {
    expect(resolveActions(["faq-agent", "contact", "meeting"], "partner")[0]).toBe("faq-agent");
  });

  it("reserves room first, so a chatty answer cannot push a guaranteed chip off", () => {
    // Four requested chips on the partner screen, which already owes two of its own.
    const { actions } = parseMessageActions(
      "x\n\n[[action:faq-agent]] [[action:contact]] [[action:meeting]] [[action:faq]]",
    );
    const resolved = resolveActions(actions, "partner");
    expect(resolved.length).toBeLessThanOrEqual(4);
    for (const id of ALWAYS_ACTIONS.partner) expect(resolved).toContain(id);
  });

  it("never exceeds the row cap on either surface", () => {
    for (const surface of ["faq", "partner"] as const) {
      const resolved = resolveActions([...NAVIO_ACTION_IDS], surface);
      expect(resolved.length).toBeLessThanOrEqual(4);
      expect(new Set(resolved).size).toBe(resolved.length);
      for (const id of ALWAYS_ACTIONS[surface]) expect(resolved).toContain(id);
    }
  });
});

describe("the data-freshness notice", () => {
  // The agent decides WHETHER it appears; a clarifying turn must stay clean, or
  // the warning becomes wallpaper the visitor stops seeing.
  it("is off unless the agent asked for it", () => {
    expect(parseMessageActions("In welcher Stadt suchst du?").notices).toEqual([]);
  });

  it("is picked up from the marker line and never rendered as text", () => {
    const { text, notices, actions } = parseMessageActions(
      "1. Yogahaus Bochum\n\n[[notice:data]] [[action:contact]]",
    );
    expect(notices).toEqual(["data"]);
    expect(actions).toEqual(["contact"]);
    expect(text).toBe("1. Yogahaus Bochum");
  });

  it("is not confused with an action of the same name", () => {
    const { actions, notices } = parseMessageActions("x\n\n[[action:data]] [[notice:data]]");
    expect(actions).toEqual([]);
    expect(notices).toEqual(["data"]);
  });

  it("drops an unknown notice instead of leaking it", () => {
    const { text, notices } = parseMessageActions("x\n\n[[notice:apocalypse]]");
    expect(notices).toEqual([]);
    expect(text).toBe("x");
  });

  it("appears once even if the agent repeats it", () => {
    expect(parseMessageActions("x\n\n[[notice:data]] [[notice:data]]").notices).toEqual(["data"]);
  });
});

describe("the live FAQ prompt only emits markers this module knows", () => {
  // The prompt is the other half of this contract, and an unknown id is dropped
  // SILENTLY — no error, no button, while the prose still says "tap the button
  // below". Nothing else in the stack would notice.
  const prompt = readFileSync("agent/instructions.md", "utf8");

  it("uses no action id the parser would discard", () => {
    const ids = [...prompt.matchAll(/\[\[action:([a-z0-9_-]+)\]\]/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of new Set(ids)) expect(NAVIO_ACTION_IDS).toContain(id);
  });

  it("still asks for the chip the FAQ screen guarantees", () => {
    for (const id of ALWAYS_ACTIONS.faq) expect(prompt).toContain(`[[action:${id}]]`);
  });
});
