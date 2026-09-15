// components/monitoring/alerts-format.ts — pure, testable (no JSX in vitest). Re-exports narrate's
// formatting so the dashboard and the messages can never disagree on a number.
// Relative (not "@/"): this is a RUNTIME import and vitest has no path alias configured.
import { fmtValue, ruleTitle } from "../../lib/monitoring/alerts/narrate";
import { humanErrored, humanRuleName } from "../../lib/monitoring/alerts/copy";
import type { ObsAgent, RuleKey } from "@/lib/monitoring/alerts/types";

export function fmtRuleValue(key: string, v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return fmtValue(key as RuleKey, n) ?? "—";
}
export function kindLabel(kind: string): string {
  return kind === "fired" ? "Alarm" : kind === "recovered" ? "Entwarnung" : kind === "digest" ? "Statusbericht" : "Test";
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

/** "Fehlerrate des FAQ-Assistenten" — what the feed and the run report show a human. */
export function humanRuleLabel(key: string, agent: string | null, subkey: string): string {
  return humanRuleName(key, agent ?? "total", subkey);
}

/** "failure_rate<dot>faq" (a rule that could not be evaluated) in plain words. */
export function humanErroredLabel(entry: string): string {
  return humanErrored(entry);
}

export interface DeliveryLabel { text: string; tone: "good" | "bad" | "muted"; detail?: string }

/**
 * Raw delivery status (as `deliver.ts` records it) → something a non-technical reader can
 * act on. The raw string survives as `detail` for the "Technische Details" block.
 */
export function humanDelivery(status: string): DeliveryLabel {
  const s = (status ?? "").trim();
  if (s === "sent" || s === "ok") return { text: "Zugestellt", tone: "good" };
  if (s === "skipped") return { text: "Nicht gesendet (nicht eingerichtet)", tone: "muted" };
  if (s.startsWith("skipped: deadline")) return { text: "Nicht gesendet (Zeit abgelaufen)", tone: "muted", detail: s };
  if (s.startsWith("skipped")) return { text: "Nicht gesendet (nicht eingerichtet)", tone: "muted", detail: s };
  if (s.startsWith("failed") || s.startsWith("error")) return { text: "Zustellung fehlgeschlagen", tone: "bad", detail: s };
  return { text: "Unbekannter Status", tone: "muted", detail: s };
}
