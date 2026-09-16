import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { captureWorkflow } from "../lib/monitoring/partner-capture";
import { createStore } from "../lib/monitoring/store";
import type { TraceDraft } from "../lib/monitoring/types";

const ENV = {
  MONITORING_SUPABASE_URL: "https://x.supabase.co",
  MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k",
} as unknown as NodeJS.ProcessEnv;
const trace = JSON.parse(readFileSync(new URL("./fixtures/v3/single-task.json", import.meta.url), "utf8")) as unknown;
const obs = { sessionId: "s1", turnId: "turn_1", message: "Yoga in Bochum", origin: null, startedAt: new Date().toISOString(), status: 200, trace };
const rpcOk = () => vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: "t", error: null }));

describe("captureWorkflow", () => {
  it("writes a mapped trace", async () => {
    const rpc = rpcOk();
    await captureWorkflow(obs, { store: createStore({ client: { rpc }, env: ENV }) });
    const p = (rpc.mock.calls[0]![1] as { p: TraceDraft }).p;
    expect(p.trace).toMatchObject({ agent: "partner", status: "completed", session_id: "s1", turn_id: "turn_1", turn_index: 1 });
    expect(p.steps.length).toBeGreaterThan(8);
  });
  it("non-2xx → failed trace with partner.upstream_error event", async () => {
    const rpc = rpcOk();
    await captureWorkflow({ ...obs, status: 502, trace: undefined, detail: "Bad Gateway" }, { store: createStore({ client: { rpc }, env: ENV }) });
    const p = (rpc.mock.calls[0]![1] as { p: TraceDraft }).p;
    expect(p.trace.status).toBe("failed");
    expect(p.events![0]!.type).toBe("partner.upstream_error");
    expect(p.errors[0]!.message).toContain("Bad Gateway");
  });
  it("fetch failure (status 0) is recorded the same way", async () => {
    const rpc = rpcOk();
    await captureWorkflow({ ...obs, status: 0, trace: undefined, detail: "fetch failed: ECONNREFUSED" }, { store: createStore({ client: { rpc }, env: ENV }) });
    expect((rpc.mock.calls[0]![1] as { p: TraceDraft }).p.trace.status).toBe("failed");
  });
  it("gives up after the cap without throwing", async () => {
    const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) => new Promise<{ data: unknown; error: null }>(() => {}));
    await expect(captureWorkflow(obs, { store: createStore({ client: { rpc }, env: ENV }), capMs: 10 })).resolves.toBeUndefined();
  });
  it("disabled store ⇒ nothing happens", async () => {
    await expect(captureWorkflow(obs, { store: createStore({ env: {} as NodeJS.ProcessEnv }) })).resolves.toBeUndefined();
  });
  it("missing ids fall back to an anonymous session rather than dropping the trace", async () => {
    const rpc = rpcOk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await captureWorkflow({ ...obs, sessionId: undefined, turnId: undefined }, { store: createStore({ client: { rpc }, env: ENV }) });
    const p = (rpc.mock.calls[0]![1] as { p: TraceDraft }).p;
    expect(p.trace.session_id.startsWith("wf_anon_")).toBe(true);
    expect(p.trace.turn_id).toBe("turn_0");
    warn.mockRestore();
  });
});
