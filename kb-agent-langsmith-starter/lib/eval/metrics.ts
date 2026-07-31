// Performance & cost metrics for evaluation runs.
//
// Extraction is grounded in the eve event stream (inspected, not assumed):
//  - `step.completed` events carry `data.usage.{inputTokens,outputTokens}`
//    (same source the dev console's SessionBar sums);
//  - every event has `meta.at` (ISO timestamp) — TTFT = first `message.*`
//    event after the last `turn.started`.
//
// Metrics are surfaced as single-value "evaluator" results so they appear as
// sortable columns in the LangSmith experiment view (one metric per function,
// SOP rule). IMPORTANT: LangSmith's own Latency column includes the rate-limit
// pacer's wait time (the pacer runs inside the target function) — `latency_s`
// here is the TRUE agent time, measured around the network call only.

export interface TurnEvent {
  type: string;
  data?: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } } & Record<string, unknown>;
  meta?: { at?: string };
}

export interface RunMetrics {
  latency_ms: number | null;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export function extractUsage(events: readonly TurnEvent[]): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  for (const event of events) {
    if (event.type === "step.completed" && event.data?.usage) {
      inputTokens += event.data.usage.inputTokens ?? 0;
      outputTokens += event.data.usage.outputTokens ?? 0;
      cacheReadTokens += event.data.usage.cacheReadTokens ?? 0;
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens };
}

/**
 * Time from the LAST `turn.started` to the first ASSISTANT output event after
 * it. `message.received` is the user's own message echo (arrives ~instantly)
 * and must NOT count — real first-token events are `message.appended` (delta)
 * or `message.completed`.
 */
export function extractTtftMs(events: readonly TurnEvent[]): number | null {
  const at = (e: TurnEvent): number => (e.meta?.at ? Date.parse(e.meta.at) : NaN);
  let turnStart: number | null = null;
  for (const e of events) {
    if (e.type === "turn.started" && !Number.isNaN(at(e))) turnStart = at(e);
  }
  if (turnStart === null) return null;
  for (const e of events) {
    if (/^message\.(appended|delta|completed)$/.test(e.type) && !Number.isNaN(at(e)) && at(e) >= turnStart) {
      return at(e) - turnStart;
    }
  }
  return null;
}

/**
 * Cached prompt reads are billed at a discount (`priceCachedPerM`) — `inputTokens`
 * is the FULL prompt count, of which `cacheReadTokens` were cache reads.
 */
export function computeCostUsd(
  usage: Usage,
  priceInPerM: number,
  priceOutPerM: number,
  priceCachedPerM: number,
): number {
  const freshIn = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  return (
    (freshIn * priceInPerM + usage.cacheReadTokens * priceCachedPerM + usage.outputTokens * priceOutPerM) / 1_000_000
  );
}

// --- metric "evaluators" ---------------------------------------------------

interface MetricRun {
  outputs?: { metrics?: Partial<RunMetrics> };
}

function metric(key: string, pick: (m: Partial<RunMetrics>) => number | null | undefined, comment: string) {
  return (run: MetricRun): { key: string; score: number; comment: string } => {
    const value = pick(run.outputs?.metrics ?? {});
    if (value === null || value === undefined || Number.isNaN(value)) {
      return { key, score: 0, comment: `${comment} — not measured for this run` };
    }
    return { key, score: value, comment };
  };
}

/** One numeric column each: latency_s, ttft_s, input/output/cache tokens, cost_usd. */
export const metricEvaluators = [
  metric("latency_s", (m) => (m.latency_ms == null ? null : Math.round(m.latency_ms / 10) / 100), "Agent time excluding rate-limit pacing"),
  metric("ttft_s", (m) => (m.ttft_ms == null ? null : Math.round(m.ttft_ms / 10) / 100), "Time to first assistant output event of the final turn"),
  metric("input_tokens", (m) => m.input_tokens, "Prompt tokens across all turns (from step.completed usage)"),
  metric("output_tokens", (m) => m.output_tokens, "Completion tokens across all turns (from step.completed usage)"),
  metric("cache_read_tokens", (m) => m.cache_read_tokens, "Cached prompt reads (billed at the cached rate)"),
  metric("cost_usd", (m) => (m.cost_usd == null ? null : Math.round(m.cost_usd * 10_000) / 10_000), "Estimated from token usage and configured per-token prices (cache-aware)"),
];
