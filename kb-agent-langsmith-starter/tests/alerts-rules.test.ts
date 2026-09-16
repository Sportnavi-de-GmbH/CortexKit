// tests/alerts-rules.test.ts
import { describe, it, expect } from "vitest";
import { evaluateRule } from "../lib/monitoring/alerts/rules";
import type { AlertRule, MetricsInput, WindowAgg } from "../lib/monitoring/alerts/types";

const agg = (o: Partial<WindowAgg> = {}): WindowAgg => ({
  traces: 0, failed: 0, abandoned: 0, cost_usd: 0, p95_ms: null, rated: 0, down: 0, error_types: [], ...o,
});
const rule = (o: Partial<AlertRule>): AlertRule => ({
  id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert",
  threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "", ...o,
});
const metrics = (w24: Partial<Record<"faq"|"partner"|"total", WindowAgg>>, costDay?: MetricsInput["costDay"]): MetricsInput => ({
  windows: { 24: { faq: w24.faq ?? agg(), partner: w24.partner ?? agg(), total: w24.total ?? agg() }, 168: { faq: agg(), partner: agg(), total: agg() } },
  costDay: costDay ?? { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } },
});

describe("failure_rate", () => {
  it("breaches above threshold with enough samples, counting abandoned as failed", () => {
    const obs = evaluateRule(rule({}), metrics({ total: agg({ traces: 20, failed: 2, abandoned: 1 }), faq: agg({ traces: 20, failed: 2, abandoned: 1 }) }));
    const total = obs.find((o) => o.agent === "total")!;
    expect(total.status).toBe("breached");
    expect(total.observed).toBeCloseTo(0.15);
    expect(total.samples).toBe(20);
  });
  it("skips below min_samples", () => {
    const obs = evaluateRule(rule({}), metrics({ total: agg({ traces: 2, failed: 1 }) }));
    expect(obs.find((o) => o.agent === "total")!.status).toBe("skipped");
  });
  it("agent='all' yields faq, partner and total observations", () => {
    expect(evaluateRule(rule({}), metrics({})).map((o) => o.agent).sort()).toEqual(["faq", "partner", "total"]);
  });
  it("agent='faq' yields only faq", () => {
    expect(evaluateRule(rule({ agent: "faq" }), metrics({})).map((o) => o.agent)).toEqual(["faq"]);
  });
});

describe("latency_p95", () => {
  it("breaches at > threshold, ok at threshold", () => {
    const r = rule({ key: "latency_p95", agent: "faq", threshold: 8000, min_samples: 10 });
    expect(evaluateRule(r, metrics({ faq: agg({ traces: 12, p95_ms: 8001 }) }))[0].status).toBe("breached");
    expect(evaluateRule(r, metrics({ faq: agg({ traces: 12, p95_ms: 8000 }) }))[0].status).toBe("ok");
  });
});

describe("cost_daily", () => {
  it("total uses threshold, agents use params.per_agent_usd", () => {
    const r = rule({ key: "cost_daily", threshold: 2, min_samples: 0, params: { per_agent_usd: 1.5 } });
    const obs = evaluateRule(r, metrics({}, { today: { faq: 1.6, partner: 0.1, total: 1.7 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } }));
    expect(obs.find((o) => o.agent === "faq")!.status).toBe("breached");
    expect(obs.find((o) => o.agent === "faq")!.threshold).toBe(1.5);
    expect(obs.find((o) => o.agent === "total")!.status).toBe("ok");
  });
});

describe("cost_spike", () => {
  const r = rule({ key: "cost_spike", severity: "warning", threshold: 3, min_samples: 0, params: { min_abs_usd: 0.5, baseline_days: 7 } });
  it("skipped while warming up (fewer baseline days than configured)", () => {
    const obs = evaluateRule(r, metrics({ total: agg({ cost_usd: 5 }) }, { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 3, baseline_avg: { faq: 0, partner: 0, total: 1 } }));
    expect(obs.find((o) => o.agent === "total")!.status).toBe("skipped");
    expect(obs.find((o) => o.agent === "total")!.note).toMatch(/warm/i);
  });
  it("breaches when 24h cost > 3x baseline and > min_abs_usd", () => {
    const obs = evaluateRule(r, metrics({ total: agg({ cost_usd: 4 }) }, { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 7, baseline_avg: { faq: 0, partner: 0, total: 1 } }));
    const t = obs.find((o) => o.agent === "total")!;
    expect(t.status).toBe("breached");
    expect(t.observed).toBe(4); // multiplier
  });
  it("never fires below min_abs_usd even at a huge multiplier", () => {
    const obs = evaluateRule(r, metrics({ total: agg({ cost_usd: 0.4 }) }, { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 7, baseline_avg: { faq: 0, partner: 0, total: 0.01 } }));
    expect(obs.find((o) => o.agent === "total")!.status).toBe("ok");
  });
});

describe("negative_feedback", () => {
  it("uses the 168h window and min votes", () => {
    const r = rule({ key: "negative_feedback", threshold: 0.3, window_hours: 168, min_samples: 5 });
    const m = metrics({});
    m.windows[168].total = agg({ rated: 6, down: 2 });
    expect(evaluateRule(r, m).find((o) => o.agent === "total")!.status).toBe("breached");
    m.windows[168].total = agg({ rated: 4, down: 4 });
    expect(evaluateRule(r, m).find((o) => o.agent === "total")!.status).toBe("skipped");
  });
});

describe("error_repeat / partner_upstream", () => {
  it("one observation per error type, ignoring upstream_unavailable", () => {
    const r = rule({ key: "error_repeat", threshold: 5, min_samples: 0 });
    const obs = evaluateRule(r, metrics({ total: agg({ error_types: [{ type: "azure_429", n: 6 }, { type: "upstream_unavailable", n: 9 }, { type: "tool_error", n: 1 }] }) }));
    const totals = obs.filter((o) => o.agent === "total");
    expect(totals.map((o) => o.subkey).sort()).toEqual(["azure_429", "tool_error"]);
    expect(totals.find((o) => o.subkey === "azure_429")!.status).toBe("breached");
    expect(totals.find((o) => o.subkey === "tool_error")!.status).toBe("ok");
  });
  it("partner_upstream counts the configured error type on partner", () => {
    const r = rule({ key: "partner_upstream", agent: "partner", threshold: 3, min_samples: 0, params: { error_type: "upstream_unavailable" } });
    const obs = evaluateRule(r, metrics({ partner: agg({ error_types: [{ type: "upstream_unavailable", n: 3 }] }) }));
    expect(obs[0].status).toBe("breached");
    expect(obs[0].observed).toBe(3);
  });
});

describe("robustness", () => {
  it("a missing window yields skipped, not a throw", () => {
    const r = rule({ window_hours: 48 });
    const obs = evaluateRule(r, metrics({}));
    expect(obs.every((o) => o.status === "skipped")).toBe(true);
  });
  it("disabled rules produce nothing", () => {
    expect(evaluateRule(rule({ enabled: false }), metrics({}))).toEqual([]);
  });
});
