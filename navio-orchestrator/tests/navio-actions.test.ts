/**
 * The marker contract between the specialist prompts, the master's verbatim relay
 * (instructions.md R7) and the chat bubble.
 *
 * Three failures matter here and none of them is loud: a marker that survives into
 * the rendered text (the visitor reads `[[action:contact]]`), a marker that is
 * silently swallowed without producing its button (the visitor is told to "tap the
 * button below" and there is none), and a guaranteed chip that a chatty answer
 * pushed off the end of the row.
 *
 * Orchestrator-specific: markers arrive RELAYED — the master may append a
 * follow-up question after the specialist's answer (R7 allows it), moving the
 * marker line mid-message; and an R6 mixed-intent turn merges TWO specialists'
 * answers (and marker lines) into one message.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GUARANTEED_ACTIONS,
  NAVIO_ACTION_IDS,
  PARTNER_GUARANTEED_ACTIONS,
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

  it("returns nothing and untouched text when the agent emits no markers", () => {
    const raw = "Kurze Rückfrage: meinst du deinen Tarif oder deinen Arbeitgeber?";
    expect(parseMessageActions(raw)).toEqual({ text: raw, actions: [], notices: [] });
  });
});

describe("relay realities (rule R7)", () => {
  it("still finds the markers when the master appends a follow-up question after them", () => {
    const { text, actions } = parseMessageActions(
      "Der Check-in läuft über den QR-Code.\n\n" +
        "[[action:contact]] [[action:about]]\n\n" +
        "Kann ich dir noch etwas zeigen?",
    );
    expect(actions).toEqual(["contact", "about"]);
    expect(text).toContain("Kann ich dir noch etwas zeigen?");
    expect(text).not.toContain("[[");
  });

  it("merges the marker lines of an R6 combined (FAQ + partner) answer, deduped", () => {
    const { text, actions, notices } = parseMessageActions(
      "Sportnavi funktioniert so: …\n\n" +
        "[[action:contact]] [[action:meeting]] [[action:about]]\n\n" +
        "Und hier sind Studios in Berlin: 1. Yogahaus …\n\n" +
        "[[notice:data]] [[action:studios]] [[action:contact]]",
    );
    expect(actions).toEqual(["contact", "meeting", "about", "studios"]);
    expect(notices).toEqual(["data"]);
    expect(text).not.toContain("[[");
  });

  it("strips the partner prompt's faq-agent marker without creating a chip", () => {
    // The partner prompt emits [[action:faq-agent]] meaning "switch to the FAQ
    // screen". There is no FAQ screen — the one chat already answers FAQ
    // questions — so the id is stripped as text but produces no dead button.
    const { text, actions } = parseMessageActions(
      "Das beantwortet dir gerne unser Team.\n\n[[action:faq-agent]] [[action:contact]]",
    );
    expect(text).toBe("Das beantwortet dir gerne unser Team.");
    expect(actions).toEqual(["contact"]);
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
  // Reaching the Sportnavi team (contact + meeting) and "Über uns" are product
  // requirements on EVERY answer, and a prompt rule alone cannot promise
  // "always" — a model skips an instruction now and then, the relay can drop the
  // marker line, and the miss is invisible.
  it("guarantees the team-contact set even on an answer that asked for nothing", () => {
    expect(resolveActions([])).toEqual(["contact", "meeting", "about"]);
  });

  it("keeps the agent's own extra chip leftmost, guarantees trailing", () => {
    expect(resolveActions(["faq", "contact", "meeting"])).toEqual([
      "faq",
      "contact",
      "meeting",
      "about",
    ]);
  });

  it("does not duplicate chips the agent did emit", () => {
    expect(resolveActions(["about", "contact"])).toEqual(["contact", "meeting", "about"]);
  });

  it("reserves room first, so a chatty answer cannot push a guaranteed chip off", () => {
    const { actions } = parseMessageActions(
      "x\n\n[[action:studios]] [[action:contact]] [[action:meeting]] [[action:faq]]",
    );
    const resolved = resolveActions(actions);
    expect(resolved.length).toBeLessThanOrEqual(4);
    for (const id of GUARANTEED_ACTIONS) expect(resolved).toContain(id);
  });

  it("never exceeds the row cap", () => {
    const resolved = resolveActions([...NAVIO_ACTION_IDS]);
    expect(resolved.length).toBeLessThanOrEqual(4);
    expect(new Set(resolved).size).toBe(resolved.length);
    for (const id of GUARANTEED_ACTIONS) expect(resolved).toContain(id);
  });
});

describe("partner turns always offer the studio search", () => {
  // Detection is event-based in the widget (a find_partners action.result names
  // its turnId), so it holds even when the relay dropped the marker line.
  it("guarantees studios + the team-contact set on a partner turn", () => {
    expect(resolveActions([], { partner: true })).toEqual([
      "studios",
      "contact",
      "meeting",
      "about",
    ]);
  });

  it("fills the whole row with the partner guarantee — no room for extras", () => {
    expect(resolveActions(["faq"], { partner: true })).toEqual(PARTNER_GUARANTEED_ACTIONS);
  });

  it("does not duplicate studios when the agent did emit it", () => {
    const resolved = resolveActions(["studios", "contact"], { partner: true });
    expect(resolved).toEqual(["studios", "contact", "meeting", "about"]);
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

describe("the live FAQ subagent prompt only emits markers this module can strip", () => {
  // The prompt is the other half of this contract. `faq-agent` is deliberately
  // NOT a chip here (there is no FAQ screen to switch to), but every id a prompt
  // emits must at least be STRIPPED — the regex handles any id, so this asserts
  // the chip-producing ids the FAQ prompt relies on are all known.
  const prompt = readFileSync("agent/subagents/faq/instructions.md", "utf8");

  it("emits at least one marker, and every chip-producing id it uses is known", () => {
    const ids = [...prompt.matchAll(/\[\[action:([a-z0-9_-]+)\]\]/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of new Set(ids)) {
      if (id === "faq-agent") continue; // stripped, deliberately chip-less
      expect(NAVIO_ACTION_IDS).toContain(id);
    }
  });

  it("still asks for the chip this widget guarantees", () => {
    for (const id of GUARANTEED_ACTIONS) expect(prompt).toContain(`[[action:${id}]]`);
  });
});
