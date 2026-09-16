// tests/alerts-repo.test.ts — repo.ts against a stubbed Supabase client (no network, no real DB).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/monitoring/store", () => ({
  supabaseAdmin: vi.fn(),
}));

import { supabaseAdmin } from "../lib/monitoring/store";
import { supabaseAlertRepo } from "../lib/monitoring/alerts/repo";

type Resp = { data: unknown; error: { message: string; code?: string } | null };

/** Minimal chainable stub covering exactly the call shapes repo.ts uses:
 *  from(table).select(cols).order(col)
 *  from(table).select(cols).eq(col, val).maybeSingle()
 *  from(table).insert(row).select(cols).maybeSingle()
 *  from(table).upsert(rows, opts)
 *  from(table).update(patch).eq(col, val)
 *  from(table).delete().in(col, vals)
 *  rpc(name, args)
 * Canned responses are keyed by "<table>.<op>" or "rpc.<name>"; a missing key
 * yields { data: null, error: null }. Every terminal call is recorded.
 */
function makeStub(responses: Record<string, Resp> = {}) {
  const calls: { key: string; args?: unknown }[] = [];
  const terminal = (key: string, args?: unknown): Promise<Resp> => {
    calls.push({ key, args });
    return Promise.resolve(responses[key] ?? { data: null, error: null });
  };
  const from = (table: string) => ({
    select: (_cols: string) => ({
      order: (_col: string) => terminal(`${table}.select.order`),
      eq: (col: string, val: unknown) => ({
        maybeSingle: () => terminal(`${table}.select.eq.maybeSingle`, { col, val }),
      }),
    }),
    insert: (row: unknown) => ({
      select: (_cols: string) => ({
        maybeSingle: () => terminal(`${table}.insert.select.maybeSingle`, row),
      }),
    }),
    upsert: (rows: unknown[], opts: unknown) => terminal(`${table}.upsert`, { rows, opts }),
    update: (patch: unknown) => ({
      eq: (col: string, val: unknown) => terminal(`${table}.update.eq`, { patch, col, val }),
    }),
    delete: () => ({
      in: (col: string, vals: unknown) => terminal(`${table}.delete.in`, { col, vals }),
    }),
  });
  const rpc = (name: string, args: unknown) => terminal(`rpc.${name}`, args);
  return { from, rpc, calls };
}

const admin = vi.mocked(supabaseAdmin);

beforeEach(() => {
  admin.mockReset();
});

describe("supabaseAlertRepo", () => {
  it("returns undefined when supabaseAdmin returns undefined", () => {
    admin.mockReturnValue(undefined as unknown as ReturnType<typeof supabaseAdmin>);
    expect(supabaseAlertRepo()).toBeUndefined();
  });

  describe("insertEvent", () => {
    it("returns inserted:false for a digest duplicate with error.code 23505", async () => {
      const stub = makeStub({
        "alert_events.insert.select.maybeSingle": {
          data: null,
          error: { code: "23505", message: 'duplicate key value violates unique constraint "alert_events_digest_slot_idx"' },
        },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const r = await repo.insertEvent({ kind: "digest", narrative: "x", narrative_source: "template", run_slot: "s1" });
      expect(r).toEqual({ inserted: false });
    });

    it("returns inserted:false for a digest duplicate matched only by message (no code)", async () => {
      const stub = makeStub({
        "alert_events.insert.select.maybeSingle": {
          data: null,
          error: { message: 'duplicate key value violates unique constraint "alert_events_digest_slot_idx"' },
        },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const r = await repo.insertEvent({ kind: "digest", narrative: "x", narrative_source: "template", run_slot: "s1" });
      expect(r).toEqual({ inserted: false });
    });

    it("throws for a non-digest kind even with the same duplicate error", async () => {
      const stub = makeStub({
        "alert_events.insert.select.maybeSingle": {
          data: null,
          error: { code: "23505", message: 'duplicate key value violates unique constraint "alert_events_digest_slot_idx"' },
        },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      await expect(
        repo.insertEvent({ kind: "fired", narrative: "x", narrative_source: "template", run_slot: "s1" }),
      ).rejects.toThrow();
    });

    it("returns inserted:true with the id on success", async () => {
      const stub = makeStub({
        "alert_events.insert.select.maybeSingle": { data: { id: "ev1" }, error: null },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const r = await repo.insertEvent({ kind: "fired", narrative: "x", narrative_source: "template", run_slot: "s1" });
      expect(r).toEqual({ inserted: true, id: "ev1" });
    });
  });

  describe("window", () => {
    it("coerces Postgres numeric strings to numbers, and keeps p95_ms null", async () => {
      const stub = makeStub({
        "rpc.monitoring_alert_window": {
          data: {
            faq: { traces: "5", failed: "1", abandoned: "0", cost_usd: "0.0123", p95_ms: "840", rated: "2", down: "0", error_types: [{ type: "x", n: "2" }] },
            partner: { traces: 0, failed: 0, abandoned: 0, cost_usd: 0, p95_ms: null, rated: 0, down: 0, error_types: [] },
            total: { traces: "5", failed: "1", abandoned: "0", cost_usd: "0.0123", p95_ms: null, rated: "2", down: "0", error_types: [] },
          },
          error: null,
        },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const r = await repo.window("production", 24);
      expect(r.faq).toEqual({
        traces: 5, failed: 1, abandoned: 0, cost_usd: 0.0123, p95_ms: 840, rated: 2, down: 0,
        error_types: [{ type: "x", n: 2 }],
      });
      expect(r.total.p95_ms).toBeNull();
      expect(r.partner.p95_ms).toBeNull();
    });
  });

  describe("settings", () => {
    it("returns defaults when maybeSingle yields data: null", async () => {
      const stub = makeStub({
        "alert_settings.select.eq.maybeSingle": { data: null, error: null },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const r = await repo.settings();
      expect(r).toEqual({ email_recipients: [], digest_enabled: true });
    });

    it("filters empty strings out of email_recipients", async () => {
      const stub = makeStub({
        "alert_settings.select.eq.maybeSingle": {
          data: { email_recipients: ["a@x.com", "", "b@x.com"], digest_enabled: false },
          error: null,
        },
      });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const r = await repo.settings();
      expect(r).toEqual({ email_recipients: ["a@x.com", "b@x.com"], digest_enabled: false });
    });
  });

  describe("saveStates", () => {
    it("makes no call for an empty array", async () => {
      const stub = makeStub();
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      await repo.saveStates([]);
      expect(stub.calls).toHaveLength(0);
    });

    it("calls upsert with onConflict rule_id,agent,subkey for non-empty rows", async () => {
      const stub = makeStub({ "alert_state.upsert": { data: null, error: null } });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      const repo = supabaseAlertRepo()!;
      const rows = [{ rule_id: "r1", agent: "faq", subkey: "", status: "ok" as const, observed: 0, samples: 5, last_evaluated_at: "2026-09-15T00:00:00Z", last_transition_at: null }];
      await repo.saveStates(rows);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].key).toBe("alert_state.upsert");
      expect(stub.calls[0].args).toMatchObject({ rows, opts: { onConflict: "rule_id,agent,subkey" } });
    });
  });

  describe("deleteStatesForRules", () => {
    it("makes no call for an empty id list", async () => {
      const stub = makeStub();
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      await supabaseAlertRepo()!.deleteStatesForRules([]);
      expect(stub.calls).toHaveLength(0);
    });

    it("deletes every alert_state row of the given rules", async () => {
      const stub = makeStub({ "alert_state.delete.in": { data: null, error: null } });
      admin.mockReturnValue(stub as unknown as ReturnType<typeof supabaseAdmin>);
      await supabaseAlertRepo()!.deleteStatesForRules(["r1", "r2"]);
      expect(stub.calls).toEqual([{ key: "alert_state.delete.in", args: { col: "rule_id", vals: ["r1", "r2"] } }]);
    });
  });
});
