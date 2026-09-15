// lib/monitoring/alerts/deliver.ts — builds AlertMessages for the monitoring rules and
// sends them through the EXISTING channels (teams.ts, graph-mail.ts). Never throws.
import type { AlertMessage } from "../format-alert";
import { sendTeamsAlert, teamsEnabled } from "../teams";
import { sendAlertEmail, graphMailEnabled } from "../graph-mail";
import { fmtObserved, fmtThreshold, ruleTitle } from "./narrate";
import type { Observation, Transition } from "./types";

export const PROJECT_LABEL = "Navio Monitoring";
const LINK_LABEL = "Dashboard öffnen";

export interface DeliverDeps { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; recipients?: string[] }
export type Delivery = { teams: string; email: string };

const SEV: Record<AlertMessage["severity"], string> = { ALERT: "🔴", WARNING: "🟡", OK: "🟢", NO_DATA: "⚪", PAUSED: "⏸️", UNKNOWN: "⚫" };
function base(severity: AlertMessage["severity"], title: string, detail: string, url: string): AlertMessage {
  return { title, detail, severity, severityEmoji: SEV[severity], severityLabel: severity, projectLabel: PROJECT_LABEL, window: "", permalink: url, linkLabel: LINK_LABEL, timestampIso: new Date().toISOString() };
}
const windowOf = (o: Observation) => (o.rule.key === "cost_daily" ? "heute (Berlin)" : `${o.rule.window_hours} h`);

export function transitionMessage(t: Transition, narrative: string, dashboardUrl: string): AlertMessage {
  const o = t.obs;
  const severity: AlertMessage["severity"] = t.kind === "recovered" ? "OK" : o.rule.severity === "alert" ? "ALERT" : "WARNING";
  const m = base(severity, ruleTitle(o.rule.key, o.agent, o.subkey), narrative, dashboardUrl);
  m.window = windowOf(o);
  m.facts = [
    { title: "Wert", value: fmtObserved(o) },
    { title: "Grenze", value: fmtThreshold(o) },
    { title: "Fenster", value: windowOf(o) },
    { title: "Turns", value: String(o.samples) },
  ];
  return m;
}

export function digestMessage(obs: Observation[], errored: string[], narrative: string, dashboardUrl: string): AlertMessage {
  const breached = obs.filter((o) => o.status === "breached").length;
  const m = base(breached > 0 ? "ALERT" : "OK", breached > 0 ? `Status: ${breached} Regel(n) verletzt` : "Status: alles im grünen Bereich", narrative, dashboardUrl);
  m.window = "Digest";
  m.facts = obs.map((o) => ({
    title: `${o.status === "breached" ? "🔴" : o.status === "skipped" ? "⚪" : "🟢"} ${ruleTitle(o.rule.key, o.agent, o.subkey)}`,
    value: `${fmtObserved(o)} / ${fmtThreshold(o)}${o.note ? ` – ${o.note}` : ""}`,
  }));
  if (errored.length) m.facts.push({ title: "⚠️ Nicht auswertbar", value: errored.join(", ") });
  return m;
}

export function testMessage(dashboardUrl: string): AlertMessage {
  return base("WARNING", "Testalarm", "Dies ist ein Testalarm aus dem Navio-Monitoring. Keine Aktion nötig.", dashboardUrl);
}

export async function deliver(msg: AlertMessage, channels: { teams: boolean; email: boolean }, deps: DeliverDeps = {}): Promise<Delivery> {
  const env = deps.env ?? process.env;
  const emailEnv: NodeJS.ProcessEnv = deps.recipients && deps.recipients.length > 0 ? { ...env, ALERT_EMAIL_TO: deps.recipients.join(",") } : env;
  const [t, e] = await Promise.allSettled([
    channels.teams && teamsEnabled(env) ? sendTeamsAlert(msg, { fetchImpl: deps.fetchImpl, env }) : Promise.resolve({ ok: false, detail: "not configured" }),
    channels.email && graphMailEnabled() ? sendAlertEmail(msg, { fetchImpl: deps.fetchImpl, env: emailEnv }) : Promise.resolve({ ok: false, detail: "not configured" }),
  ]);
  return { teams: status(t), email: status(e) };
}

function status(r: PromiseSettledResult<{ ok: boolean; detail: string }>): string {
  if (r.status === "rejected") return `failed: ${(r.reason as Error)?.message ?? String(r.reason)}`;
  if (r.value.ok) return "sent";
  if (r.value.detail === "not configured" || r.value.detail.startsWith("no recipients")) return "skipped";
  return `failed: ${r.value.detail}`;
}
