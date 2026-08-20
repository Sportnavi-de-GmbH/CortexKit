import { describe, expect, it } from "vitest";

// `agent/agent.ts` calls `defineAgent` from "eve" and `createOpenAI` from
// "@ai-sdk/openai" at module load time. Both construct their objects lazily
// (no network calls, no required env vars at import time), so a plain
// dynamic import under vitest/node succeeds without the `eve dev` runtime
// context. This test verifies the module loads cleanly and exports a
// default agent definition with a `model` field.
describe("agent scaffold", () => {
  it("agent/agent.ts imports without throwing and exports a default agent", async () => {
    const mod = await import("../agent/agent");
    expect(mod.default).toBeDefined();
    expect(mod.default).toHaveProperty("model");
  });
});
