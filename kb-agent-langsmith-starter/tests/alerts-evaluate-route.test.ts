// tests/alerts-evaluate-route.test.ts — the bearer gate of the cron-facing evaluate route.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/monitoring/alerts/evaluate", () => ({
  runEvaluation: vi.fn(async () => ({ ok: true, slot: "manual:x", dryRun: true, transitions: [], digest: { sent: false, narrative: "" }, observations: [], errored: [] })),
}));

import { POST } from "../app/api/monitoring/alerts/evaluate/route";

const SECRET = "s".repeat(64);
const post = (headers: Record<string, string> = {}, body: unknown = { dryRun: true }) =>
  POST(new Request("http://localhost/api/monitoring/alerts/evaluate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

beforeEach(() => { process.env.ALERT_EVALUATE_SECRET = SECRET; });
afterEach(() => { delete process.env.ALERT_EVALUATE_SECRET; });

describe("POST /api/monitoring/alerts/evaluate", () => {
  it("401 without an Authorization header", async () => {
    expect((await post()).status).toBe(401);
  });
  it("401 for a 64-character multibyte bearer (no RangeError, no 500)", async () => {
    const r = await post({ authorization: `Bearer ${"é".repeat(64)}` });
    expect(r.status).toBe(401);
  });
  it("404 when the secret is unset", async () => {
    delete process.env.ALERT_EVALUATE_SECRET;
    expect((await post({ authorization: `Bearer ${SECRET}` })).status).toBe(404);
  });
  it("passes the correct bearer through to the evaluator", async () => {
    const r = await post({ authorization: `Bearer ${SECRET}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });
});
