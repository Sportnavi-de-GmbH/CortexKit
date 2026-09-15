import { describe, it, expect } from "vitest";
import { narrateTransition, narrateDigest, templateTransition, templateDigest, fmtObserved, ruleTitle, humanRuleName, humanErrored } from "../lib/monitoring/alerts/narrate";
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
    expect(humanErrored("cost_spike·all")).toBe("Kostenanstieg (alle Assistenten)");
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
    expect(t).toContain("Betroffene Nutzer haben eine Fehlermeldung statt einer Antwort gesehen.");
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

describe("narrateDigest", () => {
  it("template opens with the overall state, then one human line per rule", async () => {
    const n = await narrateDigest([obs({}), obs({ status: "ok", agent: "partner", observed: 0.01 })], ["cost_spike·all"], { generate: async () => { throw new Error("x"); } });
    expect(n.source).toBe("template");
    expect(n.text).toMatch(/^Achtung: 1 Problem/);
    expect(n.text).toContain("Fehlerrate des FAQ-Assistenten");
    expect(n.text).toContain("Fehlerrate der Partner-Suche");
    expect(n.text).toContain("Nicht prüfbar: Kostenanstieg (alle Assistenten) (die Daten konnten nicht geladen werden)");
    expect(n.text).not.toMatch(/cost_spike·all|·faq/);
  });
  it("an all-clear digest says so in plain words", () => {
    const t = templateDigest([obs({ status: "ok", observed: 0.01 })], []);
    expect(t).toMatch(/^Alles in Ordnung/);
  });
});
