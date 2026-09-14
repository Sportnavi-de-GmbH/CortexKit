import { describe, expect, it, vi } from "vitest";

vi.mock("../workflow/run-workflow", () => ({
  runWorkflow: vi.fn(async (input, overrides) => ({ runId: "r", startedAt: "", totalMs: 1, status: "ok", input, config: overrides, stages: [] })),
}));
const { GET, POST } = await import("../app/api/workflow/route");

describe("POST /api/workflow", () => {
  it("400 on an invalid body", async () => {
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "" }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/query/);
  });
  it("200 with the trace, passing overrides through", async () => {
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "Yoga in Bochum", homeCity: "Essen", config: { searchRadiusKm: 12 } }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.input).toEqual({ query: "Yoga in Bochum", homeCity: "Essen", sessionCities: undefined, resume: undefined });
    expect(body.config).toEqual({ searchRadiusKm: 12 });
  });
  it("forwards resume state", async () => {
    const resume = { pending: [{ id: "p1", label: "Tennis", query: "Tennis", cityMention: null, priority: 1 }], deferred: [] };
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "Dortmund", resume }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).input.resume).toEqual(resume);
  });
  it("400 on a malformed resume task", async () => {
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "x", resume: { pending: [{ id: "", label: "", query: "", cityMention: null, priority: 1 }], deferred: [] } }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resume/);
  });
  it("GET returns defaults", async () => {
    const body = await (await GET()).json();
    expect(body.defaults.topKReranked).toBe(5);
    expect(Array.isArray(body.envSet)).toBe(true);
  });
});
