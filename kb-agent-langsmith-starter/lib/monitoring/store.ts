// The Supabase writer. Invariants (spec §5): no credentials ⇒ no-op; never
// throws; one RPC per write; one retry, then a shape-only log line and an
// in-memory event flushed with the next successful write.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { monitoringSupabase } from "./env";
import type { FeedbackDraft, MonitoringEvent, TraceDraft } from "./types";

export interface MonitoringClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface MonitoringStore {
  enabled: boolean;
  writeTrace(draft: TraceDraft): Promise<string | undefined>;
  recordFeedback(draft: FeedbackDraft): Promise<{ traceId?: string; linked: boolean } | undefined>;
  logEvent(event: MonitoringEvent): Promise<void>;
  stats(hours: number): Promise<Record<string, unknown> | undefined>;
}

export function supabaseAdmin(env: NodeJS.ProcessEnv = process.env): SupabaseClient | undefined {
  const cfg = monitoringSupabase(env);
  if (!cfg) return undefined;
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Log = (line: string, shape: Record<string, unknown>) => void;
const defaultLog: Log = (line, shape) => console.error(line, shape);

export function createStore(opts: { client?: MonitoringClient; env?: NodeJS.ProcessEnv; log?: Log } = {}): MonitoringStore {
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLog;
  const client: MonitoringClient | undefined =
    opts.client ?? (supabaseAdmin(env) as unknown as MonitoringClient | undefined);
  const enabled = client !== undefined;
  const pending: MonitoringEvent[] = [];

  /** The two `p jsonb` functions. One retry; never throws. */
  async function call(fn: string, p: unknown, shape: Record<string, unknown>): Promise<unknown> {
    if (!client) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data, error } = await client.rpc(fn, { p });
        if (error) throw new Error(error.message);
        return data;
      } catch (e) {
        if (attempt === 1) {
          log(`[monitoring] ${fn} failed`, { ...shape, error: e instanceof Error ? e.name : "unknown" });
          return undefined;
        }
      }
    }
    return undefined;
  }

  return {
    enabled,
    async writeTrace(draft) {
      if (!client) return undefined;
      const events = [...(draft.events ?? []), ...pending.splice(0)];
      const payload: TraceDraft = { ...draft, ...(events.length ? { events } : {}) };
      const data = await call("monitoring_write_trace", payload, {
        agent: draft.trace.agent,
        turnId: draft.trace.turn_id,
        steps: draft.steps.length,
        status: draft.trace.status,
      });
      if (data === undefined) {
        pending.push(...events.filter((e) => e.type !== "trace.write_failed"));
        pending.push({
          type: "trace.write_failed",
          session_id: draft.trace.session_id,
          payload: { turn_id: draft.trace.turn_id, agent: draft.trace.agent, steps: draft.steps.length },
        });
        return undefined;
      }
      return typeof data === "string" ? data : undefined;
    },
    async recordFeedback(draft) {
      if (!client) return undefined;
      const data = (await call("monitoring_record_feedback", draft, { agent: draft.agent, thumb: draft.thumb })) as
        | { trace_id: string | null; linked: boolean }
        | undefined;
      if (!data) return undefined;
      return { traceId: data.trace_id ?? undefined, linked: Boolean(data.linked) };
    },
    async logEvent(event) {
      pending.push(event);
    },
    async stats(hours) {
      if (!client) return undefined;
      try {
        const { data, error } = await client.rpc("monitoring_stats", { p_hours: hours });
        return error || !data ? undefined : (data as Record<string, unknown>);
      } catch {
        return undefined;
      }
    },
  };
}

export const store: MonitoringStore = createStore();
