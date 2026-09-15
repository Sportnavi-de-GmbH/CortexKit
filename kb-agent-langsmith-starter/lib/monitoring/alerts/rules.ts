// lib/monitoring/alerts/rules.ts — PURE. Decides ok/breached/skipped from metrics; no I/O.
// The LLM never touches this: honesty invariant (spec §6).
import type { AlertRule, MetricsInput, ObsAgent, Observation, WindowAgg } from "./types";

const AGENTS: ObsAgent[] = ["faq", "partner", "total"];

function targets(rule: AlertRule): ObsAgent[] {
  return rule.agent === "all" ? AGENTS : [rule.agent];
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}
function obs(rule: AlertRule, agent: ObsAgent, o: Omit<Observation, "rule" | "agent" | "subkey"> & { subkey?: string }): Observation {
  return { rule, agent, subkey: o.subkey ?? "", status: o.status, observed: o.observed, samples: o.samples, threshold: o.threshold, ...(o.note ? { note: o.note } : {}) };
}
function skipped(rule: AlertRule, agent: ObsAgent, note: string, threshold = rule.threshold): Observation {
  return obs(rule, agent, { status: "skipped", observed: null, samples: 0, threshold, note });
}
function ratio(rule: AlertRule, agent: ObsAgent, numer: number, denom: number): Observation {
  if (denom < Math.max(rule.min_samples, 1)) return skipped(rule, agent, `zu wenig Daten (${denom} < ${rule.min_samples})`);
  const value = numer / denom;
  return obs(rule, agent, { status: value > rule.threshold ? "breached" : "ok", observed: value, samples: denom, threshold: rule.threshold });
}

export function evaluateRule(rule: AlertRule, m: MetricsInput): Observation[] {
  if (!rule.enabled) return [];
  const win = m.windows[rule.window_hours];
  const out: Observation[] = [];

  for (const agent of targets(rule)) {
    const w: WindowAgg | undefined = win?.[agent];

    switch (rule.key) {
      case "failure_rate": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        out.push(ratio(rule, agent, w.failed + w.abandoned, w.traces));
        break;
      }
      case "latency_p95": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        if (w.traces < rule.min_samples || w.p95_ms === null) { out.push(skipped(rule, agent, `zu wenig Daten (${w.traces} < ${rule.min_samples})`)); break; }
        out.push(obs(rule, agent, { status: w.p95_ms > rule.threshold ? "breached" : "ok", observed: w.p95_ms, samples: w.traces, threshold: rule.threshold }));
        break;
      }
      case "negative_feedback": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        out.push(ratio(rule, agent, w.down, w.rated));
        break;
      }
      case "cost_daily": {
        const threshold = agent === "total" ? rule.threshold : num(rule.params.per_agent_usd, rule.threshold);
        const today = num(m.costDay.today[agent], 0);
        out.push(obs(rule, agent, { status: today > threshold ? "breached" : "ok", observed: today, samples: 0, threshold }));
        break;
      }
      case "cost_spike": {
        const baselineDays = num(rule.params.baseline_days, 7);
        const minAbs = num(rule.params.min_abs_usd, 0.5);
        if (m.costDay.baseline_days < baselineDays) { out.push(skipped(rule, agent, `Aufwärmphase (warmup): ${m.costDay.baseline_days}/${baselineDays} Tage Basis`)); break; }
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        const base = num(m.costDay.baseline_avg[agent], 0);
        const last24 = num(w.cost_usd, 0);
        const multiplier = base > 0 ? last24 / base : (last24 > 0 ? Infinity : 0);
        const breached = last24 > minAbs && multiplier > rule.threshold;
        // 999 is the "baseline was zero" sentinel: Infinity is not JSON-serialisable (it would
        // land as null in the event row and in the Teams card), so it never leaves this file.
        out.push(obs(rule, agent, { status: breached ? "breached" : "ok", observed: Number.isFinite(multiplier) ? multiplier : 999, samples: 0, threshold: rule.threshold, note: `24h ${last24.toFixed(2)} $ vs Basis ${base.toFixed(2)} $/Tag` }));
        break;
      }
      case "error_repeat": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        for (const e of w.error_types) {
          if (e.type === "upstream_unavailable") continue; // owned by partner_upstream
          out.push(obs(rule, agent, { subkey: e.type, status: e.n >= rule.threshold ? "breached" : "ok", observed: e.n, samples: e.n, threshold: rule.threshold }));
        }
        break;
      }
      case "partner_upstream": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        const type = str(rule.params.error_type, "upstream_unavailable");
        const n = w.error_types.find((e) => e.type === type)?.n ?? 0;
        out.push(obs(rule, agent, { status: n >= rule.threshold ? "breached" : "ok", observed: n, samples: n, threshold: rule.threshold }));
        break;
      }
    }
  }
  return out;
}

export function evaluateAll(rules: AlertRule[], m: MetricsInput): Observation[] {
  return rules.flatMap((r) => evaluateRule(r, m));
}
