// lib/monitoring/alerts/repo.ts — every Supabase touch for alerting, behind one interface
// so evaluate.ts is testable with an in-memory implementation.
import { supabaseAdmin } from "../store";
import type { AlertRule, AlertStateRow, CostDay, EventKind, WindowMetrics } from "./types";
import type { Delivery } from "./deliver";

export interface NewEvent {
  kind: EventKind; rule_key?: string; agent?: string; subkey?: string; severity?: string;
  observed?: number | null; threshold?: number; samples?: number; window_hours?: number;
  window_from?: string; window_to?: string; narrative: string; narrative_source: "llm" | "template"; run_slot: string;
}
export interface AlertSettings { email_recipients: string[]; digest_enabled: boolean }

export interface AlertRepo {
  rules(): Promise<AlertRule[]>;
  states(): Promise<AlertStateRow[]>;
  settings(): Promise<AlertSettings>;
  window(env: string, hours: number): Promise<WindowMetrics>;
  costDay(env: string, tz: string, baselineDays: number): Promise<CostDay>;
  saveStates(rows: AlertStateRow[]): Promise<void>;
  insertEvent(e: NewEvent): Promise<{ inserted: boolean; id?: string }>;
  updateEventDelivery(id: string, delivery: Delivery): Promise<void>;
}

const n = (v: unknown): number => (typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));

function toRule(r: Record<string, unknown>): AlertRule {
  return {
    id: String(r.id), key: r.key as AlertRule["key"], agent: r.agent as AlertRule["agent"], enabled: Boolean(r.enabled),
    severity: r.severity as AlertRule["severity"], threshold: n(r.threshold), window_hours: n(r.window_hours),
    min_samples: n(r.min_samples), params: (r.params as Record<string, unknown>) ?? {}, description: String(r.description ?? ""),
  };
}
function toAgg(w: Record<string, unknown>) {
  return { traces: n(w.traces), failed: n(w.failed), abandoned: n(w.abandoned), cost_usd: n(w.cost_usd), p95_ms: nn(w.p95_ms), rated: n(w.rated), down: n(w.down), error_types: ((w.error_types as { type: string; n: unknown }[]) ?? []).map((e) => ({ type: e.type, n: n(e.n) })) };
}

export function supabaseAlertRepo(): AlertRepo | undefined {
  const db = supabaseAdmin();
  if (!db) return undefined;
  const must = async <T,>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> => {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data as T;
  };
  return {
    rules: async () => (await must<Record<string, unknown>[]>(db.from("alert_rules").select("*").order("key"))).map(toRule),
    states: async () => (await must<Record<string, unknown>[]>(db.from("alert_state").select("*"))).map((s) => ({
      rule_id: String(s.rule_id), agent: String(s.agent), subkey: String(s.subkey ?? ""), status: s.status as AlertStateRow["status"],
      observed: nn(s.observed), samples: nn(s.samples), last_evaluated_at: String(s.last_evaluated_at), last_transition_at: (s.last_transition_at as string | null) ?? null,
    })),
    settings: async () => {
      const s = await must<Record<string, unknown> | null>(db.from("alert_settings").select("*").eq("id", 1).maybeSingle());
      return { email_recipients: ((s?.email_recipients as string[]) ?? []).filter(Boolean), digest_enabled: s ? Boolean(s.digest_enabled) : true };
    },
    window: async (env, hours) => {
      const d = await must<Record<string, Record<string, unknown>>>(db.rpc("monitoring_alert_window", { p_env: env, p_hours: hours }));
      return { faq: toAgg(d.faq), partner: toAgg(d.partner), total: toAgg(d.total) };
    },
    costDay: async (env, tz, baselineDays) => {
      const d = await must<Record<string, unknown>>(db.rpc("monitoring_alert_cost_day", { p_env: env, p_tz: tz, p_baseline_days: baselineDays }));
      const t = d.today as Record<string, unknown>; const b = d.baseline_avg as Record<string, unknown>;
      return { today: { faq: n(t.faq), partner: n(t.partner), total: n(t.total) }, baseline_days: n(d.baseline_days), baseline_avg: { faq: n(b.faq), partner: n(b.partner), total: n(b.total) } };
    },
    saveStates: async (rows) => { if (rows.length) await must(db.from("alert_state").upsert(rows, { onConflict: "rule_id,agent,subkey" })); },
    insertEvent: async (e) => {
      const q = db.from("alert_events").insert(e).select("id").maybeSingle();
      const { data, error } = await q;
      if (error) { if (e.kind === "digest" && /duplicate key|alert_events_digest_slot_idx/i.test(error.message)) return { inserted: false }; throw new Error(error.message); }
      return { inserted: true, id: data ? String((data as { id: string }).id) : undefined };
    },
    updateEventDelivery: async (id, delivery) => { await must(db.from("alert_events").update({ delivery }).eq("id", id)); },
  };
}
