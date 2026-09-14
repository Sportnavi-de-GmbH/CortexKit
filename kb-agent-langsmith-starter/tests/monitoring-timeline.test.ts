import { describe, it, expect } from "vitest";
import { durationPct, laneLayout, tableFor, visibleOrder, allIds, previewOf } from "../components/monitoring/timeline-model";

const node = (o: Record<string, unknown>) =>
  ({
    id: String(o.id ?? Math.random()), children: [], kind: "llm", name: "", status: "ok", duration_ms: 0, sequence: 0,
    input: null, output: null, metadata: {}, ...o,
  }) as never;

describe("timeline model", () => {
  it("duration percentage is bounded and never invisible", () => {
    expect(durationPct({ duration_ms: 500 }, 1000)).toBe(50);
    expect(durationPct({ duration_ms: 1 }, 100000)).toBe(2);
    expect(durationPct({ duration_ms: null }, 1000)).toBe(0);
    expect(durationPct({ duration_ms: 5000 }, 1000)).toBe(100);
  });
  it("consecutive task groups render side by side", () => {
    const rows = laneLayout([node({ id: "a" }), node({ id: "g1", kind: "group" }), node({ id: "g2", kind: "group" }), node({ id: "z" })]);
    expect(rows.map((r) => r.kind)).toEqual(["step", "lanes", "step"]);
    expect((rows[1] as { groups: { id: string }[] }).groups.map((g) => g.id)).toEqual(["g1", "g2"]);
  });
  it("tabular views for search candidates, rerank rows and recommendations", () => {
    expect(tableFor(node({ name: "search", output: { candidates: [{ id: 1, name: "A", city: "Bochum", similarity: 0.5, role: "target", distanceKm: 0 }] } }))!.rows).toHaveLength(1);
    expect(tableFor(node({ name: "rerank", output: { rows: [{ rank: 1, name: "A", finalScore: 0.9, kept: true }] } }))!.columns).toContain("finalScore");
    expect(tableFor(node({ name: "respond", output: { recommendations: [{ rank: 1, name: "A", city: "Bochum", distanceKm: 1 }] } }))!.rows).toHaveLength(1);
    expect(tableFor(node({ name: "reformulate", output: { retrievalQuery: "x" } }))).toBeNull();
    expect(tableFor(node({ name: "search", output: { candidates: [] } }))).toBeNull();
  });
  it("keyboard order follows open state; groups always show their children", () => {
    const g = node({ id: "g", kind: "group", children: [node({ id: "c1" }), node({ id: "c2", children: [node({ id: "cc" })] })] });
    const top = [node({ id: "r" }), g];
    expect(visibleOrder(top, new Set())).toEqual(["r", "g", "c1", "c2"]);
    expect(visibleOrder(top, new Set(["c2"]))).toEqual(["r", "g", "c1", "c2", "cc"]);
    expect(allIds(top)).toEqual(["r", "g", "c1", "c2", "cc"]);
  });
  it("preview collapses whitespace and truncates", () => {
    expect(previewOf({ a: 1 })).toBe('{"a":1}');
    expect(previewOf("x".repeat(200), 10)).toBe("xxxxxxxxxx…");
    expect(previewOf(null)).toBe("");
  });
});
