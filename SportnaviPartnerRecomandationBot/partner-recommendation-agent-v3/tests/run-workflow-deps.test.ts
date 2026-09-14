import { describe, expect, it, vi } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";

// Separate file on purpose: vi.mock is hoisted per file, and the other runner
// tests must keep the real (lazily imported) deps module.
vi.mock("../workflow/deps", () => ({
  createDeps: () => { throw new Error("no creds"); },
}));

describe("runWorkflow — dependency construction", () => {
  it("returns a failed trace instead of throwing when createDeps() throws", async () => {
    const run = runWorkflow({ query: "Yoga in Bochum" });
    await expect(run).resolves.toBeDefined();
    const t = await run;
    expect(t.status).toBe("failed");
    expect(t.stages).toEqual([]);
    expect(t.error?.message).toMatch(/no creds/);
    expect(t.error?.message).toMatch(/^dependencies:/);
  });
});
