import { describe, expect, it } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";
import { deps, fakeLlm } from "./_fakes";

const U = { input: 100, output: 10, cached: 20 };

describe("token usage is surfaced additively", () => {
  it("stages 0, 2 and 6 carry usage + model; task and trace sums add up", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund", usage: U });
    const t = await runWorkflow({ query: "Yoga in Dortmund" }, { enableDecomposition: true }, deps({ llm }));
    expect(t.status).toBe("ok");
    expect(t.decompose.usage).toEqual(U);
    expect(t.decompose.model).toBe("fake-model");
    const task = t.tasks[0]!;
    const byId = Object.fromEntries(task.stages.map((s) => [s.id, s]));
    expect(byId.reformulate!.usage).toEqual(U);
    expect(byId.respond!.usage).toEqual(U);
    expect(byId.respond!.model).toBe("fake-model");
    expect(byId["detect-city"]!.usage).toBeUndefined(); // stage 0's hint ⇒ no model call
    expect(task.usage).toEqual({ input: 200, output: 20, cached: 40 });
    expect(t.usage).toEqual({ input: 300, output: 30, cached: 60 });
  });

  it("a fake without usage leaves every usage field undefined (existing behaviour)", async () => {
    const t = await runWorkflow(
      { query: "Yoga in Dortmund" },
      { enableDecomposition: true },
      deps({ llm: fakeLlm({ cityMention: "Dortmund" }) }),
    );
    expect(t.usage).toBeUndefined();
    expect(t.tasks[0]!.usage).toBeUndefined();
    expect(t.decompose.usage).toBeUndefined();
  });
});
