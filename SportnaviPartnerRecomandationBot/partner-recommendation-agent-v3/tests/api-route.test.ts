import { describe, expect, it, vi } from "vitest";

vi.mock("../workflow/run-workflow", () => ({
  runWorkflow: vi.fn(async (input, overrides) => ({ runId: "r", startedAt: "", totalMs: 1, status: "ok", input, config: overrides, stages: [] })),
}));
const { GET, POST } = await import("../app/api/workflow/route");

// The route's gate reads process.env at call time: run these tests as the local
// dev UI does (loopback, no secret), and flip to production per test.
const LOOPBACK = { host: "127.0.0.1:3008" };
const post = (body: unknown, headers: Record<string, string> = LOOPBACK, url = "http://127.0.0.1:3008/api/workflow") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const basic = (secret: string) => `Basic ${Buffer.from(`navio-proxy:${secret}`).toString("base64")}`;

describe("front door", () => {
  it("production + secret: 401 without the credential, 200 with it", async () => {
    process.env.VERCEL_ENV = "production"; process.env.PARTNER_PROXY_SECRET = "prod-secret";
    try {
      const anon = await POST(post({ query: "Yoga" }, { host: "v3.vercel.app" }, "https://v3.vercel.app/api/workflow"));
      expect(anon.status).toBe(401);
      const ok = await POST(post({ query: "Yoga" }, { host: "v3.vercel.app", authorization: basic("prod-secret") }, "https://v3.vercel.app/api/workflow"));
      expect(ok.status).toBe(200);
      const get = await GET(new Request("https://v3.vercel.app/api/workflow", { headers: { host: "v3.vercel.app" } }));
      expect(get.status).toBe(401);
    } finally { delete process.env.VERCEL_ENV; delete process.env.PARTNER_PROXY_SECRET; }
  });

  it("production without a secret fails closed (503)", async () => {
    process.env.VERCEL_ENV = "production";
    try {
      const res = await POST(post({ query: "Yoga" }, { host: "v3.vercel.app" }, "https://v3.vercel.app/api/workflow"));
      expect(res.status).toBe(503);
    } finally { delete process.env.VERCEL_ENV; }
  });

  it("production ignores per-request config overrides", async () => {
    process.env.VERCEL_ENV = "production"; process.env.PARTNER_PROXY_SECRET = "prod-secret";
    try {
      const res = await POST(post({ query: "Yoga", config: { maxTasksPerTurn: 3, runTimeoutMs: 999999 } }, { host: "v3.vercel.app", authorization: basic("prod-secret") }, "https://v3.vercel.app/api/workflow"));
      expect((await res.json()).config).toEqual({});
    } finally { delete process.env.VERCEL_ENV; delete process.env.PARTNER_PROXY_SECRET; }
  });

  it("413 on an oversized body", async () => {
    const res = await POST(post({ query: "x" }, { ...LOOPBACK, "content-length": "99999" }));
    expect(res.status).toBe(413);
  });
});

describe("POST /api/workflow", () => {
  it("400 on an invalid body", async () => {
    const res = await POST(post({ query: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/query/);
  });
  it("200 with the trace, passing overrides through", async () => {
    const res = await POST(post({ query: "Yoga in Bochum", homeCity: "Essen", config: { searchRadiusKm: 12 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.input).toEqual({ query: "Yoga in Bochum", homeCity: "Essen", sessionCities: undefined, resume: undefined });
    expect(body.config).toEqual({ searchRadiusKm: 12 });
  });
  it("forwards resume state", async () => {
    const resume = { pending: [{ id: "p1", label: "Tennis", query: "Tennis", cityMention: null, priority: 1 }], deferred: [] };
    const res = await POST(post({ query: "Dortmund", resume }));
    expect(res.status).toBe(200);
    expect((await res.json()).input.resume).toEqual(resume);
  });
  it("400 on a malformed resume task", async () => {
    const res = await POST(post({ query: "x", resume: { pending: [{ id: "", label: "", query: "", cityMention: null, priority: 1 }], deferred: [] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resume/);
  });
  it("GET returns defaults", async () => {
    const body = await (await GET(new Request("http://127.0.0.1:3008/api/workflow", { headers: LOOPBACK }))).json();
    expect(body.defaults.topKReranked).toBe(5);
    expect(Array.isArray(body.envSet)).toBe(true);
  });
});
