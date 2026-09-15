// components/monitoring/alerts-format.ts — pure, testable (no JSX in vitest). Re-exports narrate's
// formatting so the dashboard and the messages can never disagree on a number.
// Relative (not "@/"): this is a RUNTIME import and vitest has no path alias configured.
import { fmtValue, ruleTitle } from "../../lib/monitoring/alerts/narrate";
import type { ObsAgent, RuleKey } from "@/lib/monitoring/alerts/types";

export function fmtRuleValue(key: string, v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return fmtValue(key as RuleKey, n) ?? "—";
}
export function kindLabel(kind: string): string {
  return kind === "fired" ? "Alarm" : kind === "recovered" ? "Entwarnung" : kind === "digest" ? "Digest" : "Test";
}
export function severityTone(kind: string, severity: string | null): "red" | "warn" | "green" | "muted" {
  if (kind === "recovered") return "green";
  if (kind === "fired") return severity === "warning" ? "warn" : "red";
  return "muted";
}
export function ruleLabel(key: string, agent: string | null, subkey: string): string {
  return ruleTitle(key as RuleKey, (agent ?? "total") as ObsAgent, subkey);
}

/**
 * Label for a rule as configured, honouring `agent: "all"` (evaluated for
 * FAQ, Partner AND Gesamt) instead of mislabelling it "· Gesamt".
 */
export function ruleScopeLabel(key: string, agent: string): string {
  if (agent === "faq" || agent === "partner") return ruleLabel(key, agent, "");
  const base = ruleTitle(key as RuleKey, "total", "").replace(/ · Gesamt$/, "");
  return `${base} · Alle Agenten`;
}
