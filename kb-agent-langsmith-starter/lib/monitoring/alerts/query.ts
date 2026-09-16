// lib/monitoring/alerts/query.ts — read side + patch schemas for the alerts dashboard. Server-only.
import { z } from "zod";
import { supabaseAdmin } from "../store";
import type { AlertRule, EventKind } from "./types";
import type { AlertSettings } from "./repo";

export interface AlertEventRow {
  id: string; kind: EventKind; rule_key: string | null; agent: string | null; subkey: string; severity: string | null;
  observed: number | null; threshold: number | null; samples: number | null; window_hours: number | null;
  window_from: string | null; window_to: string | null; narrative: string; narrative_source: string;
  delivery: Record<string, string>; run_slot: string; acknowledged_by: string | null; acknowledged_at: string | null; created_at: string;
}
export interface EventFilters { kind?: string; agent?: string; cursor?: string; limit?: number }
const KINDS = new Set(["fired", "recovered", "digest", "test"]);
const AGENTS = new Set(["faq", "partner", "total"]);

export function parseEventFilters(p: URLSearchParams): EventFilters {
  const f: EventFilters = {};
  const kind = p.get("kind"); if (kind && KINDS.has(kind)) f.kind = kind;
  const agent = p.get("agent"); if (agent && AGENTS.has(agent)) f.agent = agent;
  const cursor = p.get("cursor"); if (cursor) f.cursor = cursor;
  const limit = Number(p.get("limit")); f.limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  return f;
}

export async function listAlertEvents(f: EventFilters): Promise<{ items: AlertEventRow[]; nextCursor: string | null }> {
  const db = supabaseAdmin();
  if (!db) return { items: [], nextCursor: null };
  const limit = f.limit ?? 50;
  let q = db.from("alert_events").select("*").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (f.kind) q = q.eq("kind", f.kind);
  if (f.agent) q = q.eq("agent", f.agent);
  if (f.cursor) { const [cs, cid] = f.cursor.split("|"); if (cs && cid) q = q.or(`created_at.lt.${cs},and(created_at.eq.${cs},id.lt.${cid})`); }
  const { data, error } = await q;
  if (error || !data) return { items: [], nextCursor: null };
  const items = data.slice(0, limit) as AlertEventRow[];
  const last = items.at(-1);
  return { items, nextCursor: data.length > limit && last ? `${last.created_at}|${last.id}` : null };
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data } = await db.from("alert_rules").select("*").order("key").order("agent");
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), key: r.key as AlertRule["key"], agent: r.agent as AlertRule["agent"], enabled: Boolean(r.enabled), severity: r.severity as AlertRule["severity"],
    threshold: Number(r.threshold), window_hours: Number(r.window_hours), min_samples: Number(r.min_samples), params: (r.params as Record<string, unknown>) ?? {}, description: String(r.description ?? ""),
  }));
}

export async function getAlertSettings(): Promise<AlertSettings> {
  const db = supabaseAdmin();
  if (!db) return { email_recipients: [], digest_enabled: true };
  const { data } = await db.from("alert_settings").select("*").eq("id", 1).maybeSingle();
  const s = data as { email_recipients?: string[]; digest_enabled?: boolean } | null;
  return { email_recipients: s?.email_recipients ?? [], digest_enabled: s?.digest_enabled ?? true };
}

export async function breachedStates(): Promise<{ rule_key: string; agent: string; subkey: string; observed: number | null; last_transition_at: string | null }[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data } = await db.from("alert_state").select("agent,subkey,observed,last_transition_at,alert_rules(key)").eq("status", "breached");
  return ((data ?? []) as unknown as { agent: string; subkey: string; observed: number | null; last_transition_at: string | null; alert_rules: { key: string } | null }[])
    .map((s) => ({ rule_key: s.alert_rules?.key ?? "?", agent: s.agent, subkey: s.subkey, observed: s.observed, last_transition_at: s.last_transition_at }));
}

export const RulePatchSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(["warning", "alert"]).optional(),
  threshold: z.number().nonnegative().optional(),
  window_hours: z.number().int().min(1).max(720).optional(),
  min_samples: z.number().int().min(0).optional(),
});
export const SettingsPatchSchema = z.object({
  email_recipients: z.array(z.string().email()).max(20).optional(),
  digest_enabled: z.boolean().optional(),
});
