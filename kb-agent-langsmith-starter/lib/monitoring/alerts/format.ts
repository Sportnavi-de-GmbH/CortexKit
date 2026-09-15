// lib/monitoring/alerts/format.ts — number formatting for one rule key. Split out of
// narrate.ts so the human copy (copy.ts) can use it without importing narrate back.
import type { RuleKey } from "./types";

const de = (n: number, digits: number) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function fmtValue(key: RuleKey, v: number | null): string {
  if (v === null) return "—";
  switch (key) {
    case "failure_rate": case "negative_feedback": return `${Math.round(v * 100)} %`;
    case "latency_p95": return `${de(v / 1000, 1)} s`;
    case "cost_daily": return `${de(v, 2)} $`;
    case "cost_spike": return `${de(v, 1)}× Basis`;
    case "error_repeat": case "partner_upstream": return `${v}×`;
  }
}
