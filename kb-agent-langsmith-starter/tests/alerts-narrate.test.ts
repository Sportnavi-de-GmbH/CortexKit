import { describe, it, expect } from "vitest";
import { narrateTransition, narrateDigest, templateTransition, templateDigest, fmtObserved, ruleTitle, humanRuleName, humanErrored } from "../lib/monitoring/alerts/narrate";
import { humanHeadline, humanNote, times, windowPhrase } from "../lib/monitoring/alerts/copy";
import type { AlertRule, Observation, Transition } from "../lib/monitoring/alerts/types";

const rule = (o: Partial<AlertRule>): AlertRule => ({ id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "", ...o });
const obs = (o: Partial<Observation>): Observation => ({ rule: rule({}), agent: "faq", subkey: "", status: "breached", observed: 0.15, samples: 20, threshold: 0.1, ...o });
const fired: Transition = { kind: "fired", obs: obs({}) };

/** No rule key, no agent id, no error code, no metric jargon may reach a human. */
const TECHNICAL = /failure_rate|·faq|HTTP|p95|cost_/;

describe("formatting", () => {
  it("formats by rule key", () => {
    expect(fmtObserved(obs({}))).toBe("15 %");
    expect(fmtObserved(obs({ rule: rule({ key: "latency_p95" }), observed: 8400 }))).toBe("8,4 s");
    expect(fmtObserved(obs({ rule: rule({ key: "cost_daily" }), observed: 1.6 }))).toBe("1,60 $");
    expect(fmtObserved(obs({ rule: rule({ key: "cost_spike" }), observed: 3.2 }))).toBe("3,2× Basis");
    expect(fmtObserved(obs({ rule: rule({ key: "error_repeat" }), observed: 6 }))).toBe("6×");
  });
  it("technical titles name the agent and the error type", () => {
    expect(ruleTitle("failure_rate", "faq", "")).toBe("Fehlerrate · FAQ");
    expect(ruleTitle("error_repeat", "total", "azure_429")).toBe("Wiederholter Fehler azure_429 · Gesamt");
  });
});

describe("human names", () => {
  it("names a rule the way a colleague would", () => {
    expect(humanRuleName("failure_rate", "faq", "")).toBe("Fehlerrate des FAQ-Assistenten");
    expect(humanRuleName("latency_p95", "partner", "")).toBe("Antwortzeit der Partner-Suche");
    expect(humanRuleName("error_repeat", "total", "azure_429")).not.toMatch(/azure_429/);
  });
  it("turns an errored entry into words", () => {
    expect(humanErrored("failure_rate·faq")).toBe("Fehlerrate (FAQ-Assistent)");
    expect(humanErrored("cost_spike·all")).toBe("Kostenanstieg (beide Assistenten)");
    expect(humanErrored("nonsense")).toBe("nonsense");
  });
});

describe("narrateTransition", () => {
  it("uses the model text when it returns", async () => {
    const n = await narrateTransition(fired, { generate: async () => "Der FAQ-Assistent hat bei 15 % der Anfragen nicht geantwortet." });
    expect(n).toEqual({ text: "Der FAQ-Assistent hat bei 15 % der Anfragen nicht geantwortet.", source: "llm" });
  });
  it("falls back to the template on throw, and on timeout", async () => {
    const a = await narrateTransition(fired, { generate: async () => { throw new Error("boom"); } });
    expect(a.source).toBe("template");
    expect(a.text).toBe(templateTransition(fired));
    const b = await narrateTransition(fired, { generate: () => new Promise(() => {}), timeoutMs: 20 });
    expect(b.source).toBe("template");
  });
  it("the fired template states what, why, impact and what to do", () => {
    const t = templateTransition(fired);
    expect(t).toContain("Der FAQ-Assistent hat");
    expect(t).toContain("15 %");
    expect(t).toContain("in den letzten 24 Stunden");
    expect(t).toContain("Die Ursache ist noch nicht bekannt.");
    expect(t).toContain("Betroffene Nutzer haben keine brauchbare Antwort bekommen.");
    expect(t).toMatch(/Technik-Team/);
    expect(t.trim().endsWith("informieren.")).toBe(true);
  });
  it("the fired template contains no technical identifiers", () => {
    expect(templateTransition(fired)).not.toMatch(TECHNICAL);
    expect(templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "latency_p95", threshold: 8000 }), observed: 12000 }) })).not.toMatch(TECHNICAL);
    expect(templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "cost_daily", threshold: 2 }), observed: 2.4 }) })).not.toMatch(TECHNICAL);
    expect(templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), subkey: "azure_429", observed: 7 }) })).not.toMatch(/azure_429|·faq|HTTP/);
  });
  it("translates a known error type into a cause", () => {
    const t = templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), subkey: "azure_429", observed: 7 }) });
    expect(t).toMatch(/KI-Anbieter/);
    const u = templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), subkey: "weird_thing", observed: 7 }) });
    expect(u).toContain("Die Ursache ist noch nicht bekannt.");
  });
  it("recovery says it is fine again and that nothing has to be done", () => {
    const t = templateTransition({ kind: "recovered", obs: obs({ status: "ok", observed: 0.02 }) });
    expect(t).toMatch(/wieder/);
    expect(t).toContain("Keine Aktion nötig.");
    expect(t).not.toMatch(TECHNICAL);
  });
  it("sends the numbers and a draft to the model, not free text", async () => {
    let user = "";
    await narrateTransition(fired, { generate: async (p) => { user = p.user; return "x"; } });
    const parsed = JSON.parse(user);
    expect(parsed.observed).toBe("15 %");
    expect(parsed.threshold).toBe("10 %");
    expect(parsed.draft.what).toContain("15 %");
    expect(parsed.draft.why).toBeTruthy();
    expect(parsed.draft.impact).toBeTruthy();
    expect(parsed.draft.next).toBeTruthy();
    expect(parsed.metric).toBe("Fehlerrate des FAQ-Assistenten");
  });
});

describe("plain-German notes", () => {
  it("translates every engineer note rules.ts writes", () => {
    const n = (note: string, key: AlertRule["key"] = "failure_rate") => humanNote(obs({ rule: rule({ key }), note }));
    expect(n("Aufwärmphase (warmup): 0/7 Tage Basis", "cost_spike")).toBe("Noch nicht genug Vergleichstage gesammelt (0 von 7)");
    expect(n("zu wenig Daten (0 < 10)")).toBe("Zu wenige Anfragen im Zeitraum, um das zuverlässig zu beurteilen");
    expect(n("Fenster nicht geladen")).toBe("Die Daten konnten nicht geladen werden");
    expect(n("24h 3.20 $ vs Basis 1.00 $/Tag", "cost_spike")).toBe("Heute 3,20 $, an einem normalen Tag 1,00 $");
    expect(n("im Fenster nicht mehr aufgetreten", "error_repeat")).toBe("Im Zeitraum nicht mehr aufgetreten");
    expect(n("etwas ganz anderes")).toBeNull();
    expect(humanNote(obs({}))).toBeNull();
  });
  it("never leaks a raw note into the digest or the model JSON", async () => {
    const warm = obs({ rule: rule({ key: "cost_spike", threshold: 3 }), status: "skipped", observed: null, note: "Aufwärmphase (warmup): 0/7 Tage Basis" });
    const t = templateDigest([warm], []);
    expect(t).not.toMatch(/warmup/);
    expect(t).toContain("Noch nicht genug Vergleichstage gesammelt (0 von 7)");
    expect(t).toContain("nicht gemessen");
    expect(t).not.toMatch(/deutlich mehr/);
    let user = "";
    await narrateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "cost_spike", threshold: 3 }), observed: 3.2, note: "24h 3.20 $ vs Basis 1.00 $/Tag" }) }, { generate: async (p) => { user = p.user; return "x"; } });
    expect(JSON.parse(user).note).toBe("Heute 3,20 $, an einem normalen Tag 1,00 $");
  });
});

describe("the cost multiplier", () => {
  it("is phrased the same everywhere and never prints the 999 sentinel", () => {
    expect(times(3.2)).toBe("3,2-mal so hoch wie an einem normalen Tag");
    expect(times(999)).toBe("deutlich mehr als an einem normalen Tag");
    expect(times(Infinity)).toBe("deutlich mehr als an einem normalen Tag");
    expect(times(null)).toBe("deutlich mehr als an einem normalen Tag");
    const spike = obs({ rule: rule({ key: "cost_spike", threshold: 3 }), observed: 999, note: "24h 3.20 $ vs Basis 0.00 $/Tag" });
    const fires = templateTransition({ kind: "fired", obs: spike });
    expect(fires).toContain("deutlich mehr als an einem normalen Tag");
    expect(fires).not.toMatch(/999/);
    const digest = templateDigest([obs({ rule: rule({ key: "cost_spike", threshold: 3 }), observed: 3.2 })], []);
    expect(digest).toContain("3,2-mal so hoch wie an einem normalen Tag");
    expect(digest).not.toMatch(/× Basis/);
  });
  it("states no cost claim the data does not support", () => {
    const rec = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "cost_daily", threshold: 2 }), status: "ok", observed: 1.2 }) });
    expect(rec).not.toMatch(/keine zusätzlichen Kosten/);
    expect(rec).toContain("Die Kosten liegen wieder im geplanten Rahmen.");
    const firedCost = templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "cost_daily", threshold: 2 }), observed: 2.4 }) });
    expect(firedCost).not.toMatch(/weiter normal geantwortet/);
    expect(firedCost).toContain("Für die Nutzer ändert sich dadurch nichts Sichtbares; es geht nur um die Kosten.");
    const spikeRec = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "cost_spike", threshold: 3 }), status: "ok", observed: 1.1 }) });
    expect(spikeRec).toContain("1,1-mal so hoch wie an einem normalen Tag");
  });
});

describe("verb agreement", () => {
  it("uses plural forms when the subject is both assistants", () => {
    const rec = templateTransition({ kind: "recovered", obs: obs({ agent: "total", status: "ok", observed: 0.02 }) });
    expect(rec).toContain("Beide Assistenten haben");
    expect(rec).toContain("liegen damit wieder im normalen Bereich");
    expect(rec).not.toMatch(/Assistenten hat |liegt damit/);
    const lat = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "latency_p95", threshold: 8000 }), agent: "total", status: "ok", observed: 3000 }) });
    expect(lat).toContain("Beide Assistenten sind wieder schnell");
  });
  it("headlines agree too", () => {
    expect(humanHeadline("recovered", obs({ agent: "total", status: "ok" }))).toBe("Entwarnung: Beide Assistenten antworten wieder");
    expect(humanHeadline("recovered", obs({ agent: "faq", status: "ok" }))).toBe("Entwarnung: FAQ-Assistent antwortet wieder");
  });
});

describe("window wording and the unreachable-service cause", () => {
  it("says 'in der letzten Stunde' for a one-hour window", () => {
    expect(windowPhrase(obs({ rule: rule({ window_hours: 1 }) }))).toBe("in der letzten Stunde");
    expect(windowPhrase(obs({ rule: rule({ window_hours: 24 }) }))).toBe("in den letzten 24 Stunden");
    expect(windowPhrase(obs({ rule: rule({ window_hours: 168 }) }))).toBe("in den letzten 7 Tagen");
  });
  it("stays agent-neutral unless it is the partner search", () => {
    const faq = templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), subkey: "upstream_unavailable", observed: 7 }) });
    expect(faq).toContain("Ein benötigter Dienst war in dieser Zeit nicht erreichbar.");
    const partner = templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), agent: "partner", subkey: "upstream_unavailable", observed: 7 }) });
    expect(partner).toContain("Die Partner-Suche war in dieser Zeit nicht erreichbar.");
  });
});

describe("guard against technical model output", () => {
  it("falls back to the template when the model writes jargon", async () => {
    const n = await narrateTransition(fired, { generate: async () => "failure_rate ist 15 %" });
    expect(n.source).toBe("template");
    expect(n.text).toBe(templateTransition(fired));
    const ok = await narrateTransition(fired, { generate: async () => "Der FAQ-Assistent hat bei 15 % der Anfragen nicht geantwortet." });
    expect(ok.source).toBe("llm");
  });
});

describe("what the model is allowed to see and to write", () => {
  it("gets human numbers, never the technical multiplier", async () => {
    let user = "";
    await narrateTransition(
      { kind: "fired", obs: obs({ rule: rule({ key: "cost_spike", threshold: 3 }), observed: 3.2, threshold: 3 }) },
      { generate: async (p) => { user = p.user; return "x"; } },
    );
    expect(user).not.toMatch(/× Basis/);
    const parsed = JSON.parse(user);
    expect(parsed.observed).toBe("3,2-mal so hoch wie an einem normalen Tag");
    expect(parsed.threshold).toBe("3-mal so hoch wie an einem normalen Tag");
  });
  it("falls back to the template when the model writes a multiplier or the sentinel", async () => {
    const a = await narrateTransition(fired, { generate: async () => "Die Kosten waren 3,2× Basis." });
    expect(a.source).toBe("template");
    const b = await narrateTransition(fired, { generate: async () => "Der Wert liegt bei 999 und damit sehr hoch." });
    expect(b.source).toBe("template");
  });
});

describe("counts in human sentences", () => {
  it("reads '7-mal' and 'ab 5-mal', never '7×'", () => {
    const t = templateTransition({ kind: "fired", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), subkey: "azure_429", observed: 7, threshold: 5 }) });
    expect(t).toContain("7-mal");
    expect(t).toContain("ab 5-mal");
    expect(t).not.toMatch(/\d×/);
    // the technical view keeps the compact form
    expect(fmtObserved(obs({ rule: rule({ key: "error_repeat" }), observed: 6 }))).toBe("6×");
  });
});

describe("honest recoveries", () => {
  it("the repeated error states the count and the limit", () => {
    const r = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), subkey: "azure_429", status: "ok", observed: 4, threshold: 5 }) });
    expect(r).toContain("Der wiederholte Fehler beim FAQ-Assistenten ist in den letzten 24 Stunden nur noch 4-mal aufgetreten; gemeldet wird ab 5-mal.");
    expect(r).not.toMatch(/tritt nicht mehr auf/);
    const zero = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "error_repeat", threshold: 5 }), status: "ok", observed: 0, threshold: 5 }) });
    expect(zero).toContain("Der wiederholte Fehler beim FAQ-Assistenten ist in den letzten 24 Stunden nicht mehr aufgetreten.");
  });
  it("the partner recovery says how often it was unreachable", () => {
    const r = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "partner_upstream", threshold: 3 }), agent: "partner", status: "ok", observed: 2, threshold: 3 }) });
    expect(r).toContain("nur noch 2-mal nicht erreichbar");
    expect(r).toContain("gemeldet wird ab 3-mal");
    const zero = templateTransition({ kind: "recovered", obs: obs({ rule: rule({ key: "partner_upstream", threshold: 3 }), agent: "partner", status: "ok", observed: 0, threshold: 3 }) });
    expect(zero).toContain("durchgehend erreichbar");
  });
});

describe("narrateDigest", () => {
  it("a skipped rule shows no allowance, only what could not be measured", () => {
    const warm = obs({ rule: rule({ key: "cost_spike", threshold: 3 }), status: "skipped", observed: null, note: "Aufwärmphase (warmup): 0/7 Tage Basis" });
    const t = templateDigest([warm], []);
    expect(t).toContain("nicht gemessen – Noch nicht genug Vergleichstage gesammelt (0 von 7)");
    expect(t).not.toMatch(/erlaubt bis/);
  });
  it("template opens with the overall state, then one human line per rule", async () => {
    const n = await narrateDigest([obs({}), obs({ status: "ok", agent: "partner", observed: 0.01 })], ["cost_spike·all"], { generate: async () => { throw new Error("x"); } });
    expect(n.source).toBe("template");
    expect(n.text).toMatch(/^Achtung: 1 Problem/);
    expect(n.text).toContain("Fehlerrate des FAQ-Assistenten");
    expect(n.text).toContain("Fehlerrate der Partner-Suche");
    expect(n.text).toContain("Nicht prüfbar: Kostenanstieg (beide Assistenten) (die Daten konnten nicht geladen werden)");
    expect(n.text).not.toMatch(/cost_spike·all|·faq/);
  });
  it("an all-clear digest says so in plain words", () => {
    const t = templateDigest([obs({ status: "ok", observed: 0.01 })], []);
    expect(t).toMatch(/^Alles in Ordnung/);
  });
  it("an all-clear with an unchecked rule admits it", () => {
    const withSkipped = templateDigest([obs({ status: "ok", observed: 0.01 }), obs({ status: "skipped", observed: null, note: "Fenster nicht geladen" })], []);
    expect(withSkipped).toMatch(/^Keine Probleme gefunden — einzelne Werte konnten aber nicht geprüft werden\./);
    const withErrored = templateDigest([obs({ status: "ok", observed: 0.01 })], ["cost_spike·all"]);
    expect(withErrored).toMatch(/^Keine Probleme gefunden — einzelne Werte konnten aber nicht geprüft werden\./);
  });
});
