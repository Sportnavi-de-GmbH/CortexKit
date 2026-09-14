import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mapV3Trace, mapV3UpstreamError, type V3WorkflowTrace } from "../lib/monitoring/v3-mapper";

const fx = (n: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/v3/${n}.json`, import.meta.url), "utf8")) as V3WorkflowTrace;
const base = { sessionId: "s1", turnId: "turn_1", turnIndex: 1, agentVersion: "abc", environment: "test" };

describe("v3 mapper", () => {
  it("single task: request → decompose → one group with six children → answer-composed", () => {
    const t = fx("single-task");
    const d = mapV3Trace({ ...base, trace: t });
    expect(d.trace).toMatchObject({ session_id: "s1", agent: "partner", turn_id: "turn_1", status: "completed" });
    expect(d.trace.user_input).toBe(t.input.query);
    expect(d.trace.final_output).toBe(t.answer);
    expect(d.steps.filter((s) => !s.parent_key).map((s) => s.name)).toEqual([
      "request-received", "decompose", "task", "answer-composed",
    ]);
    const group = d.steps.find((s) => s.kind === "group")!;
    const children = d.steps.filter((s) => s.parent_key === group.step_key);
    expect(children.map((c) => c.name)).toEqual(["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"]);
    expect(children.map((c) => c.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    const search = children.find((c) => c.name === "search")!;
    expect(search.kind).toBe("tool");
    expect(search.tool_name).toBe("similarity_search");
    expect(search.output).toHaveProperty("perCity");
    expect(d.trace.tools_called).toEqual(["similarity_search"]);
    expect(d.trace.step_count).toBe(d.steps.length);
    expect(d.trace.metadata).toMatchObject({ run_id: t.runId, env: "test" });
    // real recording carries usage ⇒ tokens and models resolved
    expect(d.trace.tokens_input).toBe(t.usage!.input);
    expect(d.trace.models).toContain(t.decompose.model);
    expect(d.steps.find((s) => s.name === "respond")!.tokens_input).toBeGreaterThan(0);
  });

  it("three tasks: three sibling groups with their own children; models and usage summed", () => {
    const t = fx("three-tasks");
    const d = mapV3Trace({ ...base, trace: t });
    const groups = d.steps.filter((s) => s.kind === "group");
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.title)).toEqual(t.tasks.map((x) => `Task — ${x.task.label}`));
    expect(groups.map((g) => g.sequence)).toEqual([3, 4, 5]);
    for (const g of groups) expect(d.steps.filter((s) => s.parent_key === g.step_key)).toHaveLength(6);
    expect(d.trace.tokens_input).toBe(t.usage!.input);
    expect(d.trace.models!.length).toBeGreaterThan(0);
    expect(d.trace.tool_call_count).toBe(3);
  });

  it("needs_clarification: group is a warning carrying the clarification; trace status kept", () => {
    const t = fx("needs-clarification");
    const d = mapV3Trace({ ...base, trace: t });
    expect(d.trace.status).toBe("needs_clarification");
    const g = d.steps.find((s) => s.kind === "group")!;
    expect(g.status).toBe("warning");
    expect(g.output).toMatchObject({ clarification: expect.any(String) });
    expect(d.trace.final_output).toBe(t.clarification);
    expect(d.trace.warning_count).toBeGreaterThan(0);
    expect(d.trace.tools_called).toEqual([]); // search was skipped
  });

  it("failed: trace failed, error row present", () => {
    const t = fx("failed");
    const d = mapV3Trace({ ...base, trace: t });
    expect(d.trace.status).toBe("failed");
    expect(d.errors.length).toBeGreaterThan(0);
    expect(d.errors.some((e) => e.message === t.error!.message)).toBe(true);
    expect(d.trace.error_count).toBe(d.errors.filter((e) => e.level === "error").length);
    expect(d.steps.find((s) => s.name === "answer-composed")!.status).toBe("error");
  });

  it("copies stage warnings, config, counts, filters verbatim onto the child steps", () => {
    const t = fx("single-task");
    const d = mapV3Trace({ ...base, trace: t });
    const stage = t.tasks[0]!.stages.find((s) => s.id === "search")!;
    const step = d.steps.find((s) => s.step_key === `task:${t.tasks[0]!.task.id}/search`)!;
    expect(step.warnings).toEqual(stage.warnings);
    expect(step.metadata).toMatchObject({ config: stage.config, counts: stage.counts ?? {}, filters: stage.filters ?? {} });
    expect(step.duration_ms).toBe(stage.durationMs);
  });

  it("an upstream non-2xx becomes a failed trace with an error and a partner.upstream_error event", () => {
    const d = mapV3UpstreamError({
      ...base, userInput: "Yoga in Bochum", status: 502, body: "Bad Gateway", startedAt: "2026-09-14T10:00:00.000Z",
    });
    expect(d.trace.status).toBe("failed");
    expect(d.errors[0]).toMatchObject({ level: "error", type: "upstream_unavailable" });
    expect(d.events?.[0]?.type).toBe("partner.upstream_error");
    expect(d.steps.map((s) => s.name)).toEqual(["request-received", "failure"]);
  });
});
