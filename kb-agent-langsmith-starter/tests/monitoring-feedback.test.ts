import { describe, it, expect, vi } from "vitest";
import { recordFeedback, noteEvent } from "../lib/monitoring/feedback";
import { createStore } from "../lib/monitoring/store";

const ENV = {
  MONITORING_SUPABASE_URL: "https://x.supabase.co",
  MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k",
} as unknown as NodeJS.ProcessEnv;
const vote = { sessionId: "s1", turnId: "turn_1", thumb: "down" as const, epoch: 0, reason: "wrong_info", comment: "nein", surface: "partner" as const };
const rpcWith = (data: unknown) => vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data, error: null }));

describe("recordFeedback", () => {
  it("maps the request to a FeedbackDraft and reports linkage", async () => {
    const rpc = rpcWith({ trace_id: "t1", linked: true });
    const r = await recordFeedback(vote, { store: createStore({ client: { rpc }, env: ENV }), agentVersion: "abc" });
    expect(r).toEqual({ linked: true, traceId: "t1" });
    expect(rpc.mock.calls[0]![0]).toBe("monitoring_record_feedback");
    expect(rpc.mock.calls[0]![1]).toMatchObject({
      p: { session_id: "s1", turn_id: "turn_1", agent: "partner", thumb: "down", reason: "wrong_info", comment: "nein", epoch: 0, agent_version: "abc" },
    });
  });
  it("unlinked vote (trace not yet written) is reported as linked:false", async () => {
    const rpc = rpcWith({ trace_id: null, linked: false });
    expect(await recordFeedback(vote, { store: createStore({ client: { rpc }, env: ENV }) })).toEqual({ linked: false, traceId: undefined });
  });
  it("retraction stores thumb null; faq is the default surface", async () => {
    const rpc = rpcWith({ trace_id: "t1", linked: true });
    await recordFeedback({ ...vote, thumb: null, reason: null, comment: null, surface: undefined }, { store: createStore({ client: { rpc }, env: ENV }) });
    expect((rpc.mock.calls[0]![1] as { p: { thumb: unknown; agent: string } }).p).toMatchObject({ thumb: null, agent: "faq" });
  });
  it("never throws and is inert without creds", async () => {
    const exploding = createStore({ client: { rpc: async () => { throw new Error("x"); } }, env: ENV, log: () => {} });
    await expect(recordFeedback(vote, { store: exploding })).resolves.toBeUndefined();
    const off = createStore({ env: {} as NodeJS.ProcessEnv });
    await expect(recordFeedback(vote, { store: off })).resolves.toBeUndefined();
    await expect(noteEvent("feedback.partner_forward_failed", { status: 502 }, "s1", { store: off })).resolves.toBeUndefined();
  });
  it("noteEvent buffers an event for the next trace write", async () => {
    const rpc = rpcWith("t");
    const store = createStore({ client: { rpc }, env: ENV });
    await noteEvent("feedback.partner_forward_failed", { status: 502 }, "s1", { store });
    await store.writeTrace({ trace: { session_id: "s1", agent: "partner", turn_id: "turn_1" }, steps: [], errors: [] });
    expect((rpc.mock.calls[0]![1] as { p: { events: { type: string }[] } }).p.events[0]!.type).toBe("feedback.partner_forward_failed");
  });
});
