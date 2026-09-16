import { describe, it, expect } from "vitest";
import { parseTraceFilters, buildStepTree, traceIsAbandoned, rangeHours } from "../lib/monitoring/query";

describe("query helpers", () => {
  it("parses filters and clamps limit", () => {
    const f = parseTraceFilters(new URLSearchParams("agent=faq&status=failed&thumb=down&q=Yoga&limit=500&cursor=x"));
    expect(f).toMatchObject({ agent: "faq", status: "failed", thumb: "down", q: "Yoga", limit: 200, cursor: "x" });
    const g = parseTraceFilters(new URLSearchParams("agent=bogus&status=nope&thumb=maybe"));
    expect(g.agent).toBeUndefined();
    expect(g.status).toBeUndefined();
    expect(g.thumb).toBeUndefined();
    expect(parseTraceFilters(new URLSearchParams("")).limit).toBe(50);
    expect(parseTraceFilters(new URLSearchParams("thumb=none")).thumb).toBe("none");
  });
  it("builds the step tree by parent_step_id, ordered by sequence", () => {
    const row = (o: Record<string, unknown>) =>
      ({
        id: "", trace_id: "t", parent_step_id: null, step_key: "", parent_key: null, sequence: 0, kind: "request", name: "", title: "",
        purpose: "", status: "ok", started_at: null, duration_ms: null, input: null, output: null, tool_name: null, model: null,
        tokens_input: null, tokens_output: null, tokens_cached: null, cost_estimate_usd: null, warnings: [], error: null, metadata: {}, ...o,
      }) as never;
    const tree = buildStepTree([
      row({ id: "c2", parent_step_id: "g", sequence: 2 }),
      row({ id: "g", sequence: 2, kind: "group" }),
      row({ id: "r", sequence: 1 }),
      row({ id: "c1", parent_step_id: "g", sequence: 1 }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(["r", "g"]);
    expect(tree[1]!.children.map((n) => n.id)).toEqual(["c1", "c2"]);
  });
  it("abandoned = running for more than 5 minutes", () => {
    const now = Date.parse("2026-09-14T10:10:00Z");
    expect(traceIsAbandoned({ status: "running", started_at: "2026-09-14T10:00:00Z" }, now)).toBe(true);
    expect(traceIsAbandoned({ status: "running", started_at: "2026-09-14T10:08:00Z" }, now)).toBe(false);
    expect(traceIsAbandoned({ status: "completed", started_at: "2026-09-14T09:00:00Z" }, now)).toBe(false);
  });
  it("range → hours", () => {
    expect(rangeHours("24h")).toBe(24);
    expect(rangeHours("7d")).toBe(168);
    expect(rangeHours("30d")).toBe(720);
  });
});
