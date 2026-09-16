// lib/monitoring/alerts/types.ts — shared shapes for the alerting layer (spec §4-§6).
export type RuleKey =
  | "cost_daily" | "cost_spike" | "failure_rate" | "latency_p95"
  | "negative_feedback" | "error_repeat" | "partner_upstream";
export type RuleAgent = "all" | "faq" | "partner";
export type ObsAgent = "faq" | "partner" | "total";
export type Severity = "warning" | "alert";

export interface AlertRule {
  id: string;
  key: RuleKey;
  agent: RuleAgent;
  enabled: boolean;
  severity: Severity;
  threshold: number;
  window_hours: number;
  min_samples: number;
  params: Record<string, unknown>;
  description: string;
}

export interface WindowAgg {
  traces: number; failed: number; abandoned: number; cost_usd: number;
  p95_ms: number | null; rated: number; down: number;
  error_types: { type: string; n: number }[];
}
export interface WindowMetrics { faq: WindowAgg; partner: WindowAgg; total: WindowAgg }
export interface CostDay {
  today: Record<ObsAgent, number>;
  baseline_days: number;
  baseline_avg: Record<ObsAgent, number>;
}
export interface MetricsInput { windows: Record<number, WindowMetrics>; costDay: CostDay }

export type ObsStatus = "ok" | "breached" | "skipped";
export interface Observation {
  rule: AlertRule;
  agent: ObsAgent;
  subkey: string;
  status: ObsStatus;
  observed: number | null;
  samples: number;
  threshold: number;
  note?: string;
}

/** Row of alert_state as stored. */
export interface AlertStateRow {
  rule_id: string; agent: string; subkey: string;
  status: "ok" | "breached" | "error";
  observed: number | null; samples: number | null;
  last_evaluated_at: string; last_transition_at: string | null;
}

export type EventKind = "fired" | "recovered" | "digest" | "test";
export interface Transition {
  kind: "fired" | "recovered";
  obs: Observation;
}
