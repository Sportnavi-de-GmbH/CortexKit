import { describe, it, expect, vi } from "vitest";
import { runEvaluation } from "../lib/monitoring/alerts/evaluate";
import type { AlertRepo, NewEvent } from "../lib/monitoring/alerts/repo";
import type { AlertRule, AlertStateRow, WindowAgg } from "../lib/monitoring/alerts/types";

const agg = (o: Partial<WindowAgg> = {}): WindowAgg => ({ traces: 0, failed: 0, abandoned: 0, cost_usd: 0, p95_ms: null, rated: 0, down: 0, error_types: [], ...o });
const failureRule: AlertRule = { id: "r1", key: "failure_rate", agent: "faq", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };

function memRepo(opts: { rules?: AlertRule[]; states?: AlertStateRow[]; faq?: Partial<WindowAgg>; digest?: boolean; recipients?: string[]; windowThrows?: boolean; insertThrowsFor?: string }) {
  const events: (NewEvent & { id: string; delivery?: unknown })[] = [];
  const deleted: string[][] = [];
  let states = opts.states ?? [];
  const repo: AlertRepo = {
    rules: async () => opts.rules ?? [failureRule],
    states: async () => states,
    settings: async () => ({ email_recipients: opts.recipients ?? [], digest_enabled: opts.digest ?? true }),
    window: async () => { if (opts.windowThrows) throw new Error("db down"); return { faq: agg(opts.faq), partner: agg(), total: agg(opts.faq) }; },
    costDay: async () => ({ today: { faq: 0, partner: 0, total: 0 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } }),
    saveStates: async (rows) => {
      // Mirror the real repo's upsert on (rule_id, agent, subkey): merge incoming rows into
      // the existing set by key, leaving rows not mentioned untouched.
      const keyOf = (s: AlertStateRow) => `${s.rule_id}|${s.agent}|${s.subkey}`;
      const merged = new Map(states.map((s) => [keyOf(s), s]));
      for (const row of rows) merged.set(keyOf(row), row);
      states = [...merged.values()];
    },
    deleteStatesForRules: async (ids) => { deleted.push(ids); states = states.filter((s) => !ids.includes(s.rule_id)); },
    insertEvent: async (e) => { if (opts.insertThrowsFor && e.subkey === opts.insertThrowsFor) throw new Error("insert boom"); if (e.kind === "digest" && events.some((x) => x.kind === "digest" && x.run_slot === e.run_slot)) return { inserted: false }; const id = `e${events.length + 1}`; events.push({ ...e, id }); return { inserted: true, id }; },
    updateEventDelivery: async (id, delivery) => { const e = events.find((x) => x.id === id); if (e) e.delivery = delivery; },
  };
  return { repo, events, deleted, get states() { return states; } };
}
const deps = (repo: AlertRepo, fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch) => ({
  repo,
  narrate: { generate: async () => "LLM-Text." },
  deliver: { fetchImpl, env: { TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/hook" } as unknown as NodeJS.ProcessEnv },
});
const NOW = new Date("2026-09-15T05:00:00Z");

describe("runEvaluation", () => {
  it("fires on a fresh breach, writes state + event, delivers, and sends a digest for a scheduled slot", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    const r = await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    expect(r?.transitions).toHaveLength(1);
    expect(r?.transitions[0]).toMatchObject({ kind: "fired", rule_key: "failure_rate", agent: "faq", delivery: { teams: "sent", email: "skipped" } });
    expect(m.states[0].status).toBe("breached");
    expect(m.events.map((e) => e.kind)).toEqual(["fired", "digest"]);
    expect(m.events[0].narrative).toBe("LLM-Text.");
    expect(r?.digest.sent).toBe(true);
  });
  it("second run in the same slot: no transition, no second digest", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    const r = await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    expect(r?.transitions).toHaveLength(0);
    expect(r?.digest.sent).toBe(false);
    expect(m.events.filter((e) => e.kind === "digest")).toHaveLength(1);
  });
  it("recovers when the rate drops", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    const m2 = memRepo({ faq: { traces: 20, failed: 0 }, states: m.states });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m2.repo));
    expect(r?.transitions[0].kind).toBe("recovered");
  });
  it("test slot writes a digest event but does not send it", async () => {
    const m = memRepo({});
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "test", now: NOW }, deps(m.repo, fetchImpl));
    expect(m.events.some((e) => e.kind === "digest")).toBe(true);
    expect(r?.digest.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("digest disabled ⇒ not sent", async () => {
    const m = memRepo({ digest: false });
    const r = await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    expect(r?.digest.sent).toBe(false);
  });
  it("dryRun computes but writes and sends nothing", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "manual", now: NOW, dryRun: true }, deps(m.repo, fetchImpl));
    expect(r?.transitions).toHaveLength(1);
    expect(m.events).toHaveLength(0);
    expect(m.states).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("a failing metrics query marks the rule errored instead of ok", async () => {
    const m = memRepo({ windowThrows: true, states: [{ rule_id: "r1", agent: "faq", subkey: "", status: "breached", observed: 0.2, samples: 20, last_evaluated_at: NOW.toISOString(), last_transition_at: null }] });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    expect(r?.errored).toEqual(["failure_rate·faq"]);
    expect(r?.transitions).toHaveLength(0);
    expect(m.states[0].status).toBe("breached"); // untouched
  });
  it("delivery failure does not block the state transition", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo, fetchImpl));
    expect(r?.transitions[0].delivery?.teams).toMatch(/^failed/);
    expect(m.states[0].status).toBe("breached");
  });
  it("no repo ⇒ undefined (silent no-op)", async () => {
    expect(await runEvaluation({ slot: "manual" }, { repo: undefined })).toBeUndefined();
  });
});

const errorRepeatRule: AlertRule = { id: "r2", key: "error_repeat", agent: "faq", enabled: true, severity: "warning", threshold: 5, window_hours: 24, min_samples: 0, params: {}, description: "" };
const breachedRow = (ruleId: string, subkey: string): AlertStateRow =>
  ({ rule_id: ruleId, agent: "faq", subkey, status: "breached", observed: 9, samples: 9, last_evaluated_at: "2026-09-14T05:00:00Z", last_transition_at: "2026-09-14T05:00:00Z" });

describe("runEvaluation state reconciliation", () => {
  it("recovers a breached error_repeat subkey whose error type vanished from the window", async () => {
    const m = memRepo({ rules: [errorRepeatRule], states: [breachedRow("r2", "azure_429")], faq: { traces: 20, error_types: [] } });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    expect(r?.transitions).toHaveLength(1);
    expect(r?.transitions[0]).toMatchObject({ kind: "recovered", rule_key: "error_repeat", agent: "faq", subkey: "azure_429" });
    expect(m.states.find((s) => s.subkey === "azure_429")).toMatchObject({ status: "ok", observed: null, samples: null });
  });
  it("deletes the state rows of disabled rules and never transitions them", async () => {
    const disabled: AlertRule = { ...errorRepeatRule, enabled: false };
    const m = memRepo({ rules: [disabled], states: [breachedRow("r2", "azure_429")] });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    expect(r?.transitions).toHaveLength(0);
    expect(m.deleted).toEqual([["r2"]]);
    expect(m.states).toHaveLength(0);
  });
});

describe("runEvaluation delivery loop", () => {
  const threeErrors = { traces: 30, error_types: [{ type: "a_err", n: 9 }, { type: "b_err", n: 9 }, { type: "c_err", n: 9 }] };
  it("one failing delivery does not stop the others, and every state is saved", async () => {
    const m = memRepo({ rules: [errorRepeatRule], faq: threeErrors });
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) =>
      (typeof init?.body === "string" && init.body.includes("b_err") ? new Response("x", { status: 500 }) : new Response("1", { status: 200 }))) as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo, fetchImpl));
    const bySub = Object.fromEntries((r?.transitions ?? []).map((t) => [t.subkey, t.delivery?.teams]));
    expect(bySub.a_err).toBe("sent");
    expect(bySub.c_err).toBe("sent");
    expect(bySub.b_err).toMatch(/^failed/);
    expect(m.states.filter((s) => s.status === "breached")).toHaveLength(3);
  });
  it("a throwing insertEvent marks that transition failed but the others still deliver", async () => {
    const m = memRepo({ rules: [errorRepeatRule], faq: threeErrors, insertThrowsFor: "b_err" });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    const bySub = Object.fromEntries((r?.transitions ?? []).map((t) => [t.subkey, t.delivery?.teams]));
    expect(bySub.a_err).toBe("sent");
    expect(bySub.c_err).toBe("sent");
    expect(bySub.b_err).toMatch(/^failed/);
    expect(m.events.filter((e) => e.kind === "fired")).toHaveLength(2);
  });
});
