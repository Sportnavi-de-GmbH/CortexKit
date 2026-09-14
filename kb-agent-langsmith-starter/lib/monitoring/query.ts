// Read side for the dashboard. Server-only by construction: it builds the
// service-role client from store.ts and is imported only from server
// components, route handlers and scripts — never from a "use client" file.
import { supabaseAdmin } from "./store";
import type { Agent, StepKind, StepStatus, TraceStatus } from "./types";

export interface TraceRow {
  id: string;
  session_id: string;
  agent: Agent;
  agent_version: string | null;
  turn_id: string;
  turn_index: number | null;
  status: TraceStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  first_token_ms: number | null;
  user_input: string | null;
  final_output: string | null;
  prompt_version_id: string | null;
  models: string[];
  tools_called: string[];
  step_count: number;
  tool_call_count: number;
  error_count: number;
  warning_count: number;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  cost_estimate_usd: number | null;
  feedback_thumb: "up" | "down" | null;
  metadata: Record<string, unknown>;
}
export interface StepRow {
  id: string;
  trace_id: string;
  parent_step_id: string | null;
  step_key: string;
  parent_key: string | null;
  sequence: number;
  kind: StepKind;
  name: string;
  title: string;
  purpose: string;
  status: StepStatus;
  started_at: string | null;
  duration_ms: number | null;
  input: unknown;
  output: unknown;
  tool_name: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  cost_estimate_usd: number | null;
  warnings: string[];
  error: { message: string; type?: string } | null;
  metadata: Record<string, unknown>;
}
export interface StepNode extends StepRow {
  children: StepNode[];
}
export interface ErrorRow {
  id: string;
  trace_id: string;
  step_id: string | null;
  level: "error" | "warning";
  type: string;
  message: string;
  created_at: string;
}
export interface FeedbackRow {
  id: string;
  trace_id: string | null;
  thumb: "up" | "down" | null;
  reason: string | null;
  comment: string | null;
  epoch: number;
  created_at: string;
}
export interface PromptRow {
  id: string;
  sha256: string;
  size_chars: number;
  approx_tokens: number;
  sections: string[];
  content?: string;
  first_seen_at: string;
}
export interface SessionRow {
  id: string;
  agent: Agent;
  first_seen_at: string;
  last_seen_at: string;
  turn_count: number;
  origin: string | null;
}
export interface Stats {
  executions: number;
  succeeded: number;
  failed: number;
  abandoned: number;
  avg_ms: number | null;
  p95_ms: number | null;
  cost_usd: number;
  thumbs_up: number;
  thumbs_down: number;
  per_day: { day: string; agent: Agent; n: number }[];
  latest_errors: (ErrorRow & { agent: Agent; user_input: string | null })[];
}
export interface TraceFilters {
  agent?: Agent;
  status?: TraceStatus;
  thumb?: "up" | "down" | "none";
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

const STATUSES: TraceStatus[] = ["running", "completed", "needs_clarification", "partial", "failed"];

export function parseTraceFilters(p: URLSearchParams): TraceFilters {
  const agent = p.get("agent");
  const status = p.get("status");
  const thumb = p.get("thumb");
  const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 50));
  return {
    agent: agent === "faq" || agent === "partner" ? agent : undefined,
    status: STATUSES.includes(status as TraceStatus) ? (status as TraceStatus) : undefined,
    thumb: thumb === "up" || thumb === "down" || thumb === "none" ? thumb : undefined,
    q: p.get("q")?.trim() || undefined,
    from: p.get("from") || undefined,
    to: p.get("to") || undefined,
    cursor: p.get("cursor") || undefined,
    limit,
  };
}

export function buildStepTree(rows: StepRow[]): StepNode[] {
  const nodes = new Map<string, StepNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: StepNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_step_id ? nodes.get(n.parent_step_id) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (list: StepNode[]) => {
    list.sort((a, b) => a.sequence - b.sequence);
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** A trace still `running` after 5 minutes was never completed (invocation died). */
export function traceIsAbandoned(t: { status: string; started_at: string }, now: number = Date.now()): boolean {
  return t.status === "running" && now - Date.parse(t.started_at) > 5 * 60_000;
}

const escapeLike = (s: string) => s.replace(/[%,()]/g, " ");

export async function listTraces(f: TraceFilters): Promise<{ items: TraceRow[]; nextCursor: string | null }> {
  const db = supabaseAdmin();
  if (!db) return { items: [], nextCursor: null };
  const limit = f.limit ?? 50;
  let q = db
    .from("traces")
    .select("*")
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (f.agent) q = q.eq("agent", f.agent);
  if (f.status) q = q.eq("status", f.status);
  if (f.thumb === "none") q = q.is("feedback_thumb", null);
  else if (f.thumb) q = q.eq("feedback_thumb", f.thumb);
  if (f.from) q = q.gte("started_at", f.from);
  if (f.to) q = q.lte("started_at", f.to);
  if (f.q) {
    const s = escapeLike(f.q);
    q = q.or(`user_input.ilike.%${s}%,final_output.ilike.%${s}%`);
  }
  if (f.cursor) {
    const [cs, cid] = f.cursor.split("|");
    if (cs && cid) q = q.or(`started_at.lt.${cs},and(started_at.eq.${cs},id.lt.${cid})`);
  }
  const { data, error } = await q;
  if (error || !data) return { items: [], nextCursor: null };
  const items = data.slice(0, limit) as TraceRow[];
  const last = items.at(-1);
  return { items, nextCursor: data.length > limit && last ? `${last.started_at}|${last.id}` : null };
}

export interface TraceDetail {
  trace: TraceRow;
  steps: StepNode[];
  errors: ErrorRow[];
  feedback: FeedbackRow[];
  prompt: PromptRow | null;
}

export async function getTrace(id: string, opts: { prompt?: boolean } = {}): Promise<TraceDetail | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data: trace } = await db.from("traces").select("*").eq("id", id).maybeSingle();
  if (!trace) return null;
  const promptCols = opts.prompt ? "*" : "id,sha256,size_chars,approx_tokens,sections,first_seen_at";
  const [steps, errors, feedback, prompt] = await Promise.all([
    db.from("trace_steps").select("*").eq("trace_id", id).order("sequence"),
    db.from("errors").select("*").eq("trace_id", id).order("created_at"),
    db.from("feedback").select("*").eq("trace_id", id).order("created_at"),
    trace.prompt_version_id
      ? db.from("prompt_versions").select(promptCols).eq("id", trace.prompt_version_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return {
    trace: trace as TraceRow,
    steps: buildStepTree((steps.data ?? []) as StepRow[]),
    errors: (errors.data ?? []) as ErrorRow[],
    feedback: (feedback.data ?? []) as FeedbackRow[],
    prompt: (prompt.data as unknown as PromptRow | null) ?? null,
  };
}

export type StatsRange = "24h" | "7d" | "30d";

export function rangeHours(range: StatsRange): number {
  return range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
}

export async function getStats(range: StatsRange): Promise<Stats | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db.rpc("monitoring_stats", { p_hours: rangeHours(range) });
  return error || !data ? null : (data as Stats);
}

export async function getSession(id: string): Promise<{ session: SessionRow; traces: TraceRow[] } | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data: session } = await db.from("agent_sessions").select("*").eq("id", id).maybeSingle();
  if (!session) return null;
  const { data } = await db.from("traces").select("*").eq("session_id", id).order("started_at");
  return { session: session as SessionRow, traces: (data ?? []) as TraceRow[] };
}
