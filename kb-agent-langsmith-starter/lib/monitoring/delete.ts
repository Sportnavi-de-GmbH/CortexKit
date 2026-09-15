// lib/monitoring/delete.ts — delete traces / alert events via the two
// monitoring_delete_* RPCs (spec §3/§4). Kept light: `runEvaluation` is
// imported dynamically inside the default `reevaluate`, so importing this
// module never pulls in the whole alerts pipeline.
import { z } from "zod";
import { supabaseAdmin } from "./store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const IdsSchema = z.object({ ids: z.array(z.string().regex(UUID)).min(1).max(200) });

/** Parses a DELETE body into a validated id list, or null on any invalid shape. */
export function parseIds(body: unknown): string[] | null {
  const parsed = IdsSchema.safeParse(body);
  return parsed.success ? parsed.data.ids : null;
}

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

type Log = (line: string, shape: Record<string, unknown>) => void;
const defaultLog: Log = (line, shape) => console.error(line, shape);

export interface DeleteDeps {
  client?: RpcClient;
  reevaluate?: () => Promise<unknown>;
  reevaluateCapMs?: number;
  log?: Log;
}

export interface DeleteTracesResult {
  deleted: number;
  feedback: number;
  events: number;
  sessions_deleted: number;
  reevaluate: "started" | "skipped" | "failed";
}

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("reevaluate timed out")), ms);
  });
}

async function runReevaluate(deps: DeleteDeps): Promise<"started" | "skipped" | "failed"> {
  const log = deps.log ?? defaultLog;
  const reevaluate =
    deps.reevaluate ??
    (async () => {
      const { runEvaluation } = await import("./alerts/evaluate");
      return runEvaluation({ slot: "manual" });
    });
  try {
    const result = await Promise.race([reevaluate(), timeout(deps.reevaluateCapMs ?? 5000)]);
    return result === undefined ? "skipped" : "started";
  } catch (e) {
    log("[monitoring] delete: reevaluate failed", { error: e instanceof Error ? e.name : "unknown" });
    return "failed";
  }
}

function resolveClient(deps: DeleteDeps): RpcClient | undefined {
  return "client" in deps ? deps.client : (supabaseAdmin() as unknown as RpcClient | undefined);
}

/** Deletes traces (+ cascaded steps/errors/feedback/events, empty sessions), then
 * kicks off a background re-evaluation capped at `reevaluateCapMs`. Returns
 * undefined when there is no configured client (caller maps that to 503). */
export async function deleteTraces(ids: string[], deps: DeleteDeps = {}): Promise<DeleteTracesResult | undefined> {
  const client = resolveClient(deps);
  if (!client) return undefined;
  const { data, error } = await client.rpc("monitoring_delete_traces", { p_ids: ids });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Record<string, unknown>;
  const reevaluate = await runReevaluate(deps);
  return {
    deleted: Number(d.traces ?? 0),
    feedback: Number(d.feedback ?? 0),
    events: Number(d.events ?? 0),
    sessions_deleted: Number(d.sessions_deleted ?? 0),
    reevaluate,
  };
}

/** Deletes alert_events rows only — alert_state is untouched (spec §2). Returns
 * undefined when there is no configured client. */
export async function deleteAlertEvents(ids: string[], deps: DeleteDeps = {}): Promise<{ deleted: number } | undefined> {
  const client = resolveClient(deps);
  if (!client) return undefined;
  const { data, error } = await client.rpc("monitoring_delete_alert_events", { p_ids: ids });
  if (error) throw new Error(error.message);
  return { deleted: Number(data ?? 0) };
}
