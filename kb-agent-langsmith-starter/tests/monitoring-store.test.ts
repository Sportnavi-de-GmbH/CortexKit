import { describe, it, expect, vi } from "vitest";
import { createStore, type MonitoringClient } from "../lib/monitoring/store";
import type { TraceDraft } from "../lib/monitoring/types";

const ENV = {
  MONITORING_SUPABASE_URL: "https://x.supabase.co",
  MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k",
} as unknown as NodeJS.ProcessEnv;
const draft: TraceDraft = {
  session: { id: "s1", agent: "faq" },
  trace: { session_id: "s1", agent: "faq", turn_id: "turn_1", status: "running", user_input: "Was ist Firmenfitness?" },
  steps: [],
  errors: [],
};
const okClient = (): MonitoringClient & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: "trace-uuid", error: null };
    }),
  };
};

describe("monitoring store", () => {
  it("is a no-op without credentials", async () => {
    const client = okClient();
    const s = createStore({ env: {} as NodeJS.ProcessEnv });
    expect(s.enabled).toBe(false);
    expect(await s.writeTrace(draft)).toBeUndefined();
    expect(await s.recordFeedback({ session_id: "s1", turn_id: "turn_1", agent: "faq", thumb: "up", epoch: 0 })).toBeUndefined();
    expect(await s.stats(24)).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it("sends the draft to monitoring_write_trace and returns the id", async () => {
    const client = okClient();
    const s = createStore({ client, env: ENV });
    expect(s.enabled).toBe(true);
    expect(await s.writeTrace(draft)).toBe("trace-uuid");
    expect(client.calls[0]).toMatchObject({ fn: "monitoring_write_trace", args: { p: draft } });
  });

  it("never throws: retries once, then logs shape-only and buffers a trace.write_failed event", async () => {
    const log = vi.fn();
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: null }> => {
      throw new Error("boom " + "Was ist Firmenfitness?");
    });
    const s = createStore({ client: { rpc }, env: ENV, log });
    await expect(s.writeTrace(draft)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls[0])).not.toContain("Firmenfitness");
    // the next successful write carries the buffered event
    rpc.mockImplementation(async () => ({ data: "t2", error: null }));
    await s.writeTrace(draft);
    const sent = rpc.mock.calls[2]![1] as { p: TraceDraft };
    expect(sent.p.events?.map((e) => e.type)).toEqual(["trace.write_failed"]);
    // and it is not sent twice
    await s.writeTrace(draft);
    expect((rpc.mock.calls[3]![1] as { p: TraceDraft }).p.events).toBeUndefined();
  });

  it("treats an RPC error object like a failure", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    const s = createStore({ client: { rpc }, env: ENV, log: () => {} });
    expect(await s.writeTrace(draft)).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("records feedback through monitoring_record_feedback", async () => {
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: { trace_id: "t1", linked: true }, error: null }));
    const s = createStore({ client: { rpc }, env: ENV });
    expect(await s.recordFeedback({ session_id: "s1", turn_id: "turn_1", agent: "faq", thumb: "up", epoch: 0 })).toEqual({
      traceId: "t1",
      linked: true,
    });
    expect(rpc.mock.calls[0]![0]).toBe("monitoring_record_feedback");
  });

  it("stats passes p_hours and swallows errors", async () => {
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) =>
      args.p_hours === 24 ? { data: { executions: 3 }, error: null } : { data: null, error: { message: "x" } },
    );
    const s = createStore({ client: { rpc }, env: ENV });
    expect(await s.stats(24)).toEqual({ executions: 3 });
    expect(await s.stats(1)).toBeUndefined();
  });
});
