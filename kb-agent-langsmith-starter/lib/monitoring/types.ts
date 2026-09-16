// The in-memory shapes both capture paths produce. `store.ts` sends a
// TraceDraft verbatim to the `monitoring_write_trace(jsonb)` RPC, which MERGES
// it into the stored trace (see supabase/migrations/*_monitoring_rpc.sql).
export type Agent = "faq" | "partner";
export type StepKind = "request" | "llm" | "tool" | "retrieval" | "transform" | "response" | "error" | "group";
export type StepStatus = "ok" | "warning" | "error" | "skipped";
export type TraceStatus = "running" | "completed" | "needs_clarification" | "partial" | "failed";

export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

export interface StepDraft {
  /** Stable per trace (the RPC upsert key); groups use `task:<id>`, children `task:<id>/<stage>`. */
  step_key: string;
  parent_key?: string | null;
  sequence: number;
  kind: StepKind;
  name: string;
  title: string;
  purpose: string;
  status: StepStatus;
  started_at?: string | null;
  duration_ms?: number | null;
  input?: unknown;
  output?: unknown;
  tool_name?: string | null;
  model?: string | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cached?: number | null;
  cost_estimate_usd?: number | null;
  warnings?: string[];
  error?: { message: string; type?: string } | null;
  metadata?: Record<string, unknown>;
}

export interface ErrorDraft {
  step_key?: string;
  level: "error" | "warning";
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface MonitoringEvent {
  type: string;
  trace_id?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface PromptDraft {
  agent: Agent;
  sha256: string;
  size_chars: number;
  approx_tokens: number;
  sections: string[];
  content: string;
}

export interface TraceFields {
  session_id: string;
  agent: Agent;
  turn_id: string;
  agent_version?: string;
  turn_index?: number;
  status?: TraceStatus;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  first_token_ms?: number | null;
  user_input?: string;
  final_output?: string;
  models?: string[];
  tools_called?: string[];
  step_count?: number;
  tool_call_count?: number;
  error_count?: number;
  warning_count?: number;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cached?: number | null;
  cost_estimate_usd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface TraceDraft {
  session?: { id: string; agent: Agent; origin?: string | null; metadata?: Record<string, unknown> };
  trace: TraceFields;
  prompt?: PromptDraft;
  steps: StepDraft[];
  errors: ErrorDraft[];
  events?: MonitoringEvent[];
}

export interface FeedbackDraft {
  session_id: string;
  turn_id: string;
  agent: Agent;
  thumb: "up" | "down" | null;
  reason?: string | null;
  comment?: string | null;
  epoch: number;
  agent_version?: string;
  metadata?: Record<string, unknown>;
}

/** Sum step usage into trace totals. */
export function sumUsage(steps: StepDraft[]): {
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_estimate_usd: number;
} {
  let i = 0;
  let o = 0;
  let c = 0;
  let usd = 0;
  for (const s of steps) {
    i += s.tokens_input ?? 0;
    o += s.tokens_output ?? 0;
    c += s.tokens_cached ?? 0;
    usd += s.cost_estimate_usd ?? 0;
  }
  return { tokens_input: i, tokens_output: o, tokens_cached: c, cost_estimate_usd: Number(usd.toFixed(6)) };
}
