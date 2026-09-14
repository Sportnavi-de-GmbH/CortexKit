import { describe, expect, it } from "vitest";
import { CLARIFICATION, clarificationFor, compose, deferredNote, failedSection } from "../workflow/compose";
import type { Task, TaskRun } from "../workflow/types";

const task = (id: string, label: string): Task => ({ id, label, query: label, cityMention: null, priority: 1 });
const ok = (id: string, label: string, answer: string): TaskRun => ({ task: task(id, label), status: "ok", totalMs: 1, stages: [], answer, recommendations: [] });
const pending = (id: string, label: string): TaskRun => ({ task: task(id, label), status: "needs_clarification", totalMs: 1, stages: [], clarification: CLARIFICATION });
const failed = (id: string, label: string): TaskRun => ({ task: task(id, label), status: "failed", totalMs: 1, stages: [], error: { message: "boom" } });

describe("compose", () => {
  it("single ok task ⇒ the task answer verbatim, nothing else", () => {
    expect(compose({ tasks: [ok("a", "Yoga in Bochum", "**Gefunden.**")], deferred: [] })).toEqual({ answer: "**Gefunden.**", pending: [] });
  });

  it("single pending task ⇒ the classic clarification, no answer", () => {
    const r = compose({ tasks: [pending("a", "Yoga")], deferred: [] });
    expect(r).toEqual({ clarification: CLARIFICATION, pending: [task("a", "Yoga")] });
  });

  it("single failed task ⇒ no answer, no clarification", () => {
    expect(compose({ tasks: [failed("a", "Yoga")], deferred: [] })).toEqual({ pending: [] });
  });

  it("multiple tasks ⇒ headed sections in task order", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T-answer"), ok("b", "Boxen in München", "B-answer")], deferred: [] });
    expect(r.answer).toBe("**Tennis in Dortmund**\nT-answer\n\n**Boxen in München**\nB-answer");
    expect(r.clarification).toBeUndefined();
  });

  it("a pending task gets one question after the sections and is returned in pending", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T"), pending("b", "Rückenschmerzen"), ok("c", "Boxen in München", "B")], deferred: [] });
    const q = clarificationFor(["Rückenschmerzen"]);
    expect(q).toBe(`Kurze Frage, bevor ich weitersuche 😄 – für „Rückenschmerzen“: in welcher Stadt (oder Umgebung) soll ich schauen?`);
    expect(r.answer).toBe(`**Tennis in Dortmund**\nT\n\n**Boxen in München**\nB\n\n${q}`);
    expect(r.clarification).toBe(q);
    expect(r.pending.map((p) => p.id)).toEqual(["b"]);
  });

  it("two pending tasks share one question", () => {
    expect(clarificationFor(["Tennis", "Boxen"])).toContain(`für „Tennis“ und „Boxen“`);
  });

  it("deferred tasks are noted last", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T")], deferred: [task("d", "Klettern in Köln"), task("e", "Schwimmen in Essen")] });
    expect(deferredNote(["Klettern in Köln", "Schwimmen in Essen"])).toBe(`(Notiert für danach: Klettern in Köln, Schwimmen in Essen – sag einfach Bescheid, dann suche ich weiter.)`);
    expect(r.answer).toBe(`**Tennis in Dortmund**\nT\n\n${deferredNote(["Klettern in Köln", "Schwimmen in Essen"])}`);
  });

  it("a failed task renders a templated apology instead of vanishing", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T"), failed("b", "Boxen in München")], deferred: [] });
    expect(failedSection("Boxen in München")).toBe(`**Boxen in München**\nBei „Boxen in München“ ist gerade etwas schiefgelaufen – versuch es gleich noch einmal.`);
    expect(r.answer).toBe(`**Tennis in Dortmund**\nT\n\n${failedSection("Boxen in München")}`);
  });
});
