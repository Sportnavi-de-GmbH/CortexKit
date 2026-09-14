import { describe, expect, it } from "vitest";
import { decompose } from "../workflow/stages/0-decompose";
import { ctx, fakeLlm, rawTask } from "./_fakes";
import type { Task } from "../workflow/types";

const Q = "Tennis in Dortmund, Boxen in München und etwas gegen Rückenschmerzen in München";
const THREE = [
  rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund" }),
  rawTask({ label: "Boxen in München", query: "Boxen in München", cityMention: "München", priority: 2 }),
  rawTask({ label: "Rückenschmerzen in München", query: "etwas gegen Rückenschmerzen in München", cityMention: "München", priority: 3 }),
];
const task = (id: string, query: string, priority = 1): Task => ({ id, label: query, query, cityMention: null, priority });

describe("stage 0 — decompose — single-intent keeps original text", () => {
  it("one raw task with a shortened query and no pending tasks ⇒ output query is the user's original text", async () => {
    const raw = [rawTask({ label: "Reha-Sport", query: "Reha-Sport gesucht", cityMention: "Dortmund" })];
    const original = "Ich hab mir das Knie verletzt und suche Reha-Sport in Dortmund bitte helft mir";
    const r = await decompose({ query: original }, ctx({}, { llm: fakeLlm({ decompose: raw }) }));
    expect(r.output.tasks).toHaveLength(1);
    expect(r.output.tasks[0]!.query).toBe(original);
    expect(r.output.tasks[0]!.label).toBe("Reha-Sport");
    expect(r.output.tasks[0]!.cityMention).toBe("Dortmund");
  });

  it("one raw task that resolves a pending id keeps the model's completed query, not the reply text", async () => {
    const pending = [task("p1", "Tennis")];
    const llm = fakeLlm({ decompose: (_q, p) => [rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", resolvesPending: p[0]!.id })] });
    const r = await decompose({ query: "Dortmund", resume: { pending, deferred: [] } }, ctx({}, { llm }));
    expect(r.output.tasks).toHaveLength(1);
    expect(r.output.tasks[0]!.query).toBe("Tennis in Dortmund");
    expect(r.output.tasks[0]!.id).toBe("p1");
  });

  it("two raw tasks ⇒ queries are left untouched", async () => {
    const raw = [
      rawTask({ label: "A", query: "Kurzfassung A", cityMention: "Essen" }),
      rawTask({ label: "B", query: "Kurzfassung B", cityMention: "Bochum", priority: 2 }),
    ];
    const r = await decompose({ query: "A und B, das lange Original" }, ctx({}, { llm: fakeLlm({ decompose: raw }) }));
    expect(r.output.tasks.map((t) => t.query)).toEqual(["Kurzfassung A", "Kurzfassung B"]);
  });
});

describe("stage 0 — decompose", () => {
  it("splits the message into tasks with fresh ids and puts them all in runnable when ≤ max", async () => {
    const r = await decompose({ query: Q }, ctx({}, { llm: fakeLlm({ decompose: THREE }) }));
    expect(r.output.tasks.map((t) => t.label)).toEqual(["Tennis in Dortmund", "Boxen in München", "Rückenschmerzen in München"]);
    expect(new Set(r.output.tasks.map((t) => t.id)).size).toBe(3);
    expect(r.output.runnable).toHaveLength(3);
    expect(r.output.deferred).toEqual([]);
    expect(r.output.degraded).toBe(false);
    expect(r.output.fresh).toEqual(r.output.tasks.map((t) => t.id));
    expect(r.output.model).toBe("fake-model");
    expect(r.counts).toMatchObject({ fresh: 3, carried: 0, runnable: 3, deferred: 0 });
  });

  it("defers everything beyond maxTasksPerTurn", async () => {
    const five = [...THREE, rawTask({ query: "Klettern in Köln", cityMention: "Köln", priority: 4 }), rawTask({ query: "Schwimmen in Essen", cityMention: "Essen", priority: 5 })];
    const r = await decompose({ query: Q }, ctx({ maxTasksPerTurn: 3 }, { llm: fakeLlm({ decompose: five }) }));
    expect(r.output.runnable.map((t) => t.query)).toEqual(["Tennis in Dortmund", "Boxen in München", "etwas gegen Rückenschmerzen in München"]);
    expect(r.output.deferred.map((t) => t.query)).toEqual(["Klettern in Köln", "Schwimmen in Essen"]);
  });

  it("sorts by priority, then mention order", async () => {
    const raw = [rawTask({ query: "Yoga", priority: 2 }), rawTask({ query: "Boxen in Essen", cityMention: "Essen", priority: 1 }), rawTask({ query: "Tennis in Bochum", cityMention: "Bochum", priority: 1 })];
    const r = await decompose({ query: "x" }, ctx({}, { llm: fakeLlm({ decompose: raw }) }));
    expect(r.output.tasks.map((t) => t.query)).toEqual(["Boxen in Essen", "Tennis in Bochum", "Yoga"]);
  });

  it("dedupes identical queries, clamps labels, defaults a bad priority, caps at 10", async () => {
    const raw = [
      rawTask({ label: "x".repeat(80), query: "Yoga in Bochum", priority: Number.NaN }),
      rawTask({ query: "yoga in bochum " }),
      ...Array.from({ length: 12 }, (_, i) => rawTask({ query: `Sport ${i} in Essen`, priority: 5 })),
    ];
    const r = await decompose({ query: "x" }, ctx({}, { llm: fakeLlm({ decompose: raw }) }));
    expect(r.output.tasks).toHaveLength(10);
    expect(r.output.tasks[0]!.label).toHaveLength(40);
    expect(r.output.tasks[0]!.priority).toBe(1);
    expect(r.output.tasks.filter((t) => t.query.toLowerCase().trim() === "yoga in bochum")).toHaveLength(1);
  });

  it("degrades to one task when the model fails", async () => {
    const r = await decompose({ query: Q }, ctx({}, { llm: fakeLlm({ failDecompose: new Error("model down") }) }));
    expect(r.output.degraded).toBe(true);
    expect(r.output.tasks).toEqual([expect.objectContaining({ query: Q, cityMention: null, priority: 1 })]);
    expect(r.output.tasks[0]!.label).toBe(Q.slice(0, 40));
    expect(r.warnings?.[0]).toMatch(/model down/);
  });

  it("degrades to one task when the model returns nothing usable", async () => {
    const r = await decompose({ query: Q }, ctx({}, { llm: fakeLlm({ decompose: [rawTask({ query: "   " })] }) }));
    expect(r.output.degraded).toBe(true);
    expect(r.output.tasks).toHaveLength(1);
    expect(r.warnings?.[0]).toMatch(/no tasks/i);
  });

  it("skips the model when decomposition is disabled", async () => {
    const llm = fakeLlm({ decompose: THREE });
    const r = await decompose({ query: Q }, ctx({ enableDecomposition: false }, { llm }));
    expect(llm.calls).toEqual([]);
    expect(r.output.tasks).toHaveLength(1);
    expect(r.output.degraded).toBe(false);
    expect(r.config).toEqual({ enableDecomposition: false, maxTasksPerTurn: 3 });
  });

  it("merges a reply into the pending task it resolves, keeping that task's id", async () => {
    const pending = [task("p1", "Tennis")];
    const llm = fakeLlm({ decompose: (_q, p) => [rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", resolvesPending: p[0]!.id })] });
    const r = await decompose({ query: "Dortmund", resume: { pending, deferred: [] } }, ctx({}, { llm }));
    expect(r.output.tasks).toEqual([{ id: "p1", label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", priority: 1 }]);
  });

  it("carries deferred tasks first, ahead of new ones, and drops unmerged pending tasks", async () => {
    const deferred = [task("d1", "Klettern in Köln"), task("d2", "Schwimmen in Essen")];
    const pending = [task("p1", "Tennis")];
    const r = await decompose(
      { query: "Und Yoga in Bochum bitte", resume: { pending, deferred } },
      ctx({ maxTasksPerTurn: 2 }, { llm: fakeLlm({ decompose: [rawTask({ query: "Yoga in Bochum", cityMention: "Bochum" })] }) }),
    );
    expect(r.output.tasks.map((t) => t.id)).toEqual(["d1", "d2", expect.any(String)]);
    expect(r.output.runnable.map((t) => t.id)).toEqual(["d1", "d2"]);
    expect(r.output.deferred.map((t) => t.query)).toEqual(["Yoga in Bochum"]);
    expect(r.output.tasks.some((t) => t.id === "p1")).toBe(false);
    expect(r.output.fresh).toHaveLength(1);
    expect(r.counts).toMatchObject({ fresh: 1, carried: 2, runnable: 2, deferred: 1 });
  });

  it("a pending id can be claimed by at most one task; a second claimant gets a fresh id", async () => {
    const pending = [task("p1", "Tennis")];
    const llm = fakeLlm({ decompose: () => [
      rawTask({ query: "Tennis in Dortmund", cityMention: "Dortmund", resolvesPending: "p1" }),
      rawTask({ query: "Tennis in Bochum", cityMention: "Bochum", resolvesPending: "p1", priority: 2 }),
    ] });
    const r = await decompose({ query: "Dortmund und Bochum", resume: { pending, deferred: [] } }, ctx({}, { llm }));
    expect(r.output.tasks.map((t) => t.id)[0]).toBe("p1");
    expect(r.output.tasks[1]!.id).not.toBe("p1");
    expect(new Set(r.output.tasks.map((t) => t.id)).size).toBe(2);
  });

  it("caps the carried+fresh task list at 10, dropping the tail, with a warning naming the dropped labels", async () => {
    const deferred = Array.from({ length: 10 }, (_, i) => task(`d${i}`, `Carried ${i}`));
    const fresh = [
      rawTask({ label: "Fresh A", query: "Fresh A", cityMention: "Essen" }),
      rawTask({ label: "Fresh B", query: "Fresh B", cityMention: "Essen", priority: 2 }),
      rawTask({ label: "Fresh C", query: "Fresh C", cityMention: "Essen", priority: 3 }),
    ];
    const r = await decompose(
      { query: "x", resume: { pending: [], deferred } },
      ctx({ maxTasksPerTurn: 3 }, { llm: fakeLlm({ decompose: fresh }) }),
    );
    expect(r.output.tasks).toHaveLength(10);
    expect(r.output.tasks.map((t) => t.id)).toEqual(deferred.map((t) => t.id));
    expect(r.output.deferred).toHaveLength(7);
    expect(r.output.runnable.map((t) => t.id)).toEqual(["d0", "d1", "d2"]);
    expect(r.warnings?.some((w) => /Task list capped at 10/.test(w) && /Fresh A/.test(w) && /Fresh B/.test(w) && /Fresh C/.test(w))).toBe(true);
  });
});
