// tests/monitoring-delete.test.ts — lib/monitoring/delete.ts against a stubbed RPC client (no network).
import { describe, it, expect, vi } from "vitest";
import { parseIds, deleteTraces, deleteAlertEvents } from "../lib/monitoring/delete";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

function makeClient(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data, error }));
  return { rpc };
}

describe("parseIds", () => {
  it("accepts a single uuid", () => {
    expect(parseIds({ ids: [UUID_A] })).toEqual([UUID_A]);
  });
  it("accepts multiple uuids", () => {
    expect(parseIds({ ids: [UUID_A, UUID_B] })).toEqual([UUID_A, UUID_B]);
  });
  it("rejects an empty array", () => {
    expect(parseIds({ ids: [] })).toBeNull();
  });
  it("rejects more than 200 ids", () => {
    const ids = Array.from({ length: 201 }, (_, i) => UUID_A);
    expect(parseIds({ ids })).toBeNull();
  });
  it("accepts exactly 200 ids", () => {
    const ids = Array.from({ length: 200 }, () => UUID_A);
    expect(parseIds({ ids })).toHaveLength(200);
  });
  it("rejects a non-uuid entry", () => {
    expect(parseIds({ ids: ["not-a-uuid"] })).toBeNull();
  });
  it("rejects a non-object body", () => {
    expect(parseIds("nope")).toBeNull();
    expect(parseIds(null)).toBeNull();
    expect(parseIds(undefined)).toBeNull();
    expect(parseIds(42)).toBeNull();
  });
  it("rejects a body missing ids", () => {
    expect(parseIds({})).toBeNull();
  });
});

describe("deleteTraces", () => {
  it("calls the RPC with p_ids and maps the jsonb result; reevaluate resolving => started", async () => {
    const client = makeClient({ traces: 2, feedback: 1, events: 3, sessions_deleted: 1 });
    const reevaluate = vi.fn(async () => ({ ok: true }));
    const result = await deleteTraces([UUID_A, UUID_B], { client, reevaluate });
    expect(client.rpc).toHaveBeenCalledWith("monitoring_delete_traces", { p_ids: [UUID_A, UUID_B] });
    expect(result).toEqual({ deleted: 2, feedback: 1, events: 3, sessions_deleted: 1, reevaluate: "started" });
  });

  it("swallows a rejecting reevaluate and reports failed, without throwing", async () => {
    const client = makeClient({ traces: 1, feedback: 0, events: 0, sessions_deleted: 0 });
    const log = vi.fn();
    const reevaluate = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await deleteTraces([UUID_A], { client, reevaluate, log });
    expect(result?.reevaluate).toBe("failed");
    expect(log).toHaveBeenCalled();
  });

  it("reports skipped when reevaluate resolves undefined (no repo)", async () => {
    const client = makeClient({ traces: 1, feedback: 0, events: 0, sessions_deleted: 0 });
    const reevaluate = vi.fn(async () => undefined);
    const result = await deleteTraces([UUID_A], { client, reevaluate });
    expect(result?.reevaluate).toBe("skipped");
  });

  it("reports pending (not failed) when reevaluate outlives the cap, and hands the promise to keepAlive", async () => {
    const client = makeClient({ traces: 1, feedback: 0, events: 0, sessions_deleted: 0 });
    const log = vi.fn();
    const keepAlive = vi.fn();
    const reevaluate = vi.fn(() => new Promise(() => {})); // never resolves
    const result = await deleteTraces([UUID_A], { client, reevaluate, reevaluateCapMs: 20, log, keepAlive });
    expect(result?.reevaluate).toBe("pending");
    expect(keepAlive).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
  it("a rejection after the cap is logged, never unhandled", async () => {
    const client = makeClient({ traces: 1, feedback: 0, events: 0, sessions_deleted: 0 });
    const log = vi.fn();
    let reject!: (e: Error) => void;
    const reevaluate = vi.fn(() => new Promise((_r, rj) => { reject = rj; }));
    const result = await deleteTraces([UUID_A], { client, reevaluate, reevaluateCapMs: 20, log });
    expect(result?.reevaluate).toBe("pending");
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("throws on an RPC error", async () => {
    const client = makeClient(null, { message: "db exploded" });
    await expect(deleteTraces([UUID_A], { client, reevaluate: vi.fn(async () => undefined) })).rejects.toThrow(
      "db exploded",
    );
  });

  it("returns undefined when there is no client", async () => {
    const result = await deleteTraces([UUID_A], { client: undefined, reevaluate: vi.fn(async () => undefined) });
    expect(result).toBeUndefined();
  });
});

describe("deleteAlertEvents", () => {
  it("calls the RPC with p_ids and maps the int result", async () => {
    const client = makeClient(3);
    const result = await deleteAlertEvents([UUID_A, UUID_B], { client });
    expect(client.rpc).toHaveBeenCalledWith("monitoring_delete_alert_events", { p_ids: [UUID_A, UUID_B] });
    expect(result).toEqual({ deleted: 3 });
  });

  it("throws on an RPC error", async () => {
    const client = makeClient(null, { message: "db exploded" });
    await expect(deleteAlertEvents([UUID_A], { client })).rejects.toThrow("db exploded");
  });

  it("returns undefined when there is no client", async () => {
    const result = await deleteAlertEvents([UUID_A], { client: undefined });
    expect(result).toBeUndefined();
  });
});
