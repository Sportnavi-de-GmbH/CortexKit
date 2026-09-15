import { describe, it, expect } from "vitest";
import { narrateTransition, narrateDigest, templateTransition, fmtObserved, ruleTitle } from "../lib/monitoring/alerts/narrate";
import type { AlertRule, Observation, Transition } from "../lib/monitoring/alerts/types";

const rule = (o: Partial<AlertRule>): AlertRule => ({ id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "", ...o });
const obs = (o: Partial<Observation>): Observation => ({ rule: rule({}), agent: "faq", subkey: "", status: "breached", observed: 0.15, samples: 20, threshold: 0.1, ...o });
const fired: Transition = { kind: "fired", obs: obs({}) };

describe("formatting", () => {
  it("formats by rule key", () => {
    expect(fmtObserved(obs({}))).toBe("15 %");
    expect(fmtObserved(obs({ rule: rule({ key: "latency_p95" }), observed: 8400 }))).toBe("8,4 s");
    expect(fmtObserved(obs({ rule: rule({ key: "cost_daily" }), observed: 1.6 }))).toBe("1,60 $");
    expect(fmtObserved(obs({ rule: rule({ key: "cost_spike" }), observed: 3.2 }))).toBe("3,2× Basis");
    expect(fmtObserved(obs({ rule: rule({ key: "error_repeat" }), observed: 6 }))).toBe("6×");
  });
  it("titles name the agent and the error type", () => {
    expect(ruleTitle("failure_rate", "faq", "")).toBe("Fehlerrate · FAQ");
    expect(ruleTitle("error_repeat", "total", "azure_429")).toBe("Wiederholter Fehler azure_429 · Gesamt");
  });
});

describe("narrateTransition", () => {
  it("uses the model text when it returns", async () => {
    const n = await narrateTransition(fired, { generate: async () => "Die Fehlerrate des FAQ-Agenten liegt bei 15 %." });
    expect(n).toEqual({ text: "Die Fehlerrate des FAQ-Agenten liegt bei 15 %.", source: "llm" });
  });
  it("falls back to the template on throw, and on timeout", async () => {
    const a = await narrateTransition(fired, { generate: async () => { throw new Error("boom"); } });
    expect(a.source).toBe("template");
    expect(a.text).toBe(templateTransition(fired));
    const b = await narrateTransition(fired, { generate: () => new Promise(() => {}), timeoutMs: 20 });
    expect(b.source).toBe("template");
  });
  it("template states metric, value, threshold, window and a first check", () => {
    const t = templateTransition(fired);
    expect(t).toContain("Fehlerrate · FAQ");
    expect(t).toContain("15 %");
    expect(t).toContain("10 %");
    expect(t).toContain("24 h");
    expect(t).toMatch(/prüfen/i);
  });
  it("recovery template says recovered", () => {
    expect(templateTransition({ kind: "recovered", obs: obs({ status: "ok", observed: 0.02 }) })).toMatch(/wieder im grünen Bereich/);
  });
  it("sends the numbers to the model, not free text", async () => {
    let user = "";
    await narrateTransition(fired, { generate: async (p) => { user = p.user; return "x"; } });
    const parsed = JSON.parse(user);
    expect(parsed.observed).toBe("15 %");
    expect(parsed.threshold).toBe("10 %");
  });
});

describe("narrateDigest", () => {
  it("template lists every observation and errored rules", async () => {
    const n = await narrateDigest([obs({}), obs({ status: "ok", agent: "partner", observed: 0.01 })], ["cost_spike"], { generate: async () => { throw new Error("x"); } });
    expect(n.source).toBe("template");
    expect(n.text).toContain("Fehlerrate · FAQ");
    expect(n.text).toContain("Fehlerrate · Partner");
    expect(n.text).toContain("cost_spike");
  });
});
