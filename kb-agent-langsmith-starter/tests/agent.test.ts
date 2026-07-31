// Baseline smoke test: the agent definition must stay importable with an
// empty environment (guide §11, Step V1 — the first rung of the ladder).
// Hook/filter tests are added while following the guide (Parts A–B).
import { describe, expect, it } from "vitest";

describe("agent definition", () => {
  it("is importable and declares the KB agent", async () => {
    const mod = await import("../agent/agent.ts");
    const agent = mod.default as { description?: string };
    expect(agent).toBeTruthy();
    expect(agent.description).toContain("Knowledge Base");
  });
});
