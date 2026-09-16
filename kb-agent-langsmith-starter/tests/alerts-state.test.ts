import { describe, it, expect } from "vitest";
import { diffStates, runSlot } from "../lib/monitoring/alerts/state";
import type { AlertRule, AlertStateRow, Observation } from "../lib/monitoring/alerts/types";

const rule: AlertRule = { id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };
const o = (status: Observation["status"], agent: Observation["agent"] = "total", subkey = ""): Observation =>
  ({ rule, agent, subkey, status, observed: 0.2, samples: 20, threshold: 0.1 });
const prev = (status: AlertStateRow["status"], agent = "total", subkey = ""): AlertStateRow =>
  ({ rule_id: "r1", agent, subkey, status, observed: 0.05, samples: 20, last_evaluated_at: "2026-09-15T05:00:00Z", last_transition_at: null });
const NOW = "2026-09-15T13:00:00Z";

describe("diffStates", () => {
  it("absent → breached fires", () => {
    const { transitions, next } = diffStates([], [o("breached")], NOW);
    expect(transitions).toEqual([{ kind: "fired", obs: o("breached") }]);
    expect(next[0]).toMatchObject({ status: "breached", last_transition_at: NOW, last_evaluated_at: NOW });
  });
  it("ok → breached fires; breached → breached is silent", () => {
    expect(diffStates([prev("ok")], [o("breached")], NOW).transitions).toHaveLength(1);
    expect(diffStates([prev("breached")], [o("breached")], NOW).transitions).toHaveLength(0);
  });
  it("breached → ok recovers; ok → ok silent; absent → ok silent", () => {
    expect(diffStates([prev("breached")], [o("ok")], NOW).transitions[0].kind).toBe("recovered");
    expect(diffStates([prev("ok")], [o("ok")], NOW).transitions).toHaveLength(0);
    expect(diffStates([], [o("ok")], NOW).transitions).toHaveLength(0);
  });
  it("skipped keeps the previous status and never transitions", () => {
    const r = diffStates([prev("breached")], [o("skipped")], NOW);
    expect(r.transitions).toHaveLength(0);
    expect(r.next[0].status).toBe("breached");
  });
  it("subkeys are independent", () => {
    const r = diffStates([prev("breached", "total", "azure_429")], [o("breached", "total", "azure_429"), o("breached", "total", "tool_error")], NOW);
    expect(r.transitions.map((t) => t.obs.subkey)).toEqual(["tool_error"]);
  });
  it("keeps last_transition_at when unchanged", () => {
    const p = { ...prev("ok"), last_transition_at: "2026-09-01T00:00:00Z" };
    expect(diffStates([p], [o("ok")], NOW).next[0].last_transition_at).toBe("2026-09-01T00:00:00Z");
  });
  it("error + breached fires; error + ok does not transition", () => {
    const r1 = diffStates([prev("error")], [o("breached")], NOW);
    expect(r1.transitions.map((t) => t.kind)).toEqual(["fired"]);
    expect(r1.next[0].status).toBe("breached");
    const r2 = diffStates([prev("error")], [o("ok")], NOW);
    expect(r2.transitions).toHaveLength(0);
    expect(r2.next[0].status).toBe("ok");
  });
  it("a breached row of an evaluated rule with no observation recovers", () => {
    const r = diffStates([prev("breached", "total", "azure_429")], [], NOW, [rule]);
    expect(r.transitions).toHaveLength(1);
    expect(r.transitions[0].kind).toBe("recovered");
    expect(r.transitions[0].obs).toMatchObject({ agent: "total", subkey: "azure_429", status: "ok", observed: 0, samples: 0, threshold: rule.threshold, note: "im Fenster nicht mehr aufgetreten" });
    expect(r.next[0]).toMatchObject({ status: "ok", observed: null, samples: null, last_evaluated_at: NOW, last_transition_at: NOW });
  });
  it("an ok row with no observation stays ok and does not transition", () => {
    const r = diffStates([prev("ok", "total", "azure_429")], [], NOW, [rule]);
    expect(r.transitions).toHaveLength(0);
    expect(r.next[0]).toMatchObject({ status: "ok", observed: null, samples: null, last_evaluated_at: NOW });
  });
  it("rows of rules that were not evaluated are left alone", () => {
    const r = diffStates([prev("breached", "total", "azure_429")], [], NOW);
    expect(r.transitions).toHaveLength(0);
    expect(r.next).toHaveLength(0);
  });
});

describe("runSlot", () => {
  it("scheduled = Berlin hour; test/manual = Berlin minute", () => {
    const d = new Date("2026-09-15T05:07:30Z"); // 07:07 CEST
    expect(runSlot("scheduled", d)).toBe("2026-09-15T07");
    expect(runSlot("test", d)).toBe("test:2026-09-15T07:07");
    expect(runSlot("manual", d)).toBe("manual:2026-09-15T07:07");
  });
  it("winter time shifts by one hour", () => {
    expect(runSlot("scheduled", new Date("2026-12-15T06:00:00Z"))).toBe("2026-12-15T07");
  });
});
