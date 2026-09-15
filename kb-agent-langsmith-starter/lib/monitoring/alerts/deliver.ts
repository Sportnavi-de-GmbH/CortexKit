// lib/monitoring/alerts/deliver.ts — builds AlertMessages for the monitoring rules and
// sends them through the EXISTING channels (teams.ts, graph-mail.ts). Never throws.
// Title and body are the human story; every identifier, raw value and threshold goes into the
// separate "Für das Technik-Team" block so the readable part stays readable.
import { HUMAN_SEVERITY, type AlertMessage } from "../format-alert";
import { sendTeamsAlert, teamsEnabled } from "../teams";
import { sendAlertEmail, graphMailEnabled } from "../graph-mail";
import { fmtObserved, fmtThreshold, humanHeadline, humanRuleName } from "./narrate";
import { humanErrored, humanNote, humanThreshold, humanValue } from "./copy";
import type { Observation, Transition } from "./types";

export const PROJECT_LABEL = "Navio Monitoring";
export const TECH_LABEL = "Für das Technik-Team";
const LINK_LABEL = "Dashboard öffnen";

export interface DeliverDeps { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; recipients?: string[] }
export type Delivery = { teams: string; email: string };

const SEV: Record<AlertMessage["severity"], string> = { ALERT: "🔴", WARNING: "🟡", OK: "🟢", NO_DATA: "⚪", PAUSED: "⏸️", UNKNOWN: "⚫" };
function base(severity: AlertMessage["severity"], title: string, detail: string, url: string): AlertMessage {
  return { title, detail, severity, severityEmoji: SEV[severity], severityLabel: severity, humanSeverity: HUMAN_SEVERITY[severity], projectLabel: PROJECT_LABEL, window: "", permalink: url, linkLabel: LINK_LABEL, timestampIso: new Date().toISOString() };
}
const windowOf = (o: Observation) => (o.rule.key === "cost_daily" ? "heute (Berlin)" : `${o.rule.window_hours} h`);
const ruleRef = (o: Observation) => `${o.rule.key}·${o.agent}${o.subkey ? `·${o.subkey}` : ""}`;

export function transitionMessage(t: Transition, narrative: string, dashboardUrl: string): AlertMessage {
  const o = t.obs;
  const severity: AlertMessage["severity"] = t.kind === "recovered" ? "OK" : o.rule.severity === "alert" ? "ALERT" : "WARNING";
  const m = base(severity, humanHeadline(t.kind, o), narrative, dashboardUrl);
  m.window = windowOf(o);
  m.techLabel = TECH_LABEL;
  m.techFacts = [
    { title: "Regel", value: ruleRef(o) },
    { title: "Agent", value: o.agent },
    { title: "Wert", value: fmtObserved(o) },
    { title: "Grenze", value: fmtThreshold(o) },
    { title: "Fenster", value: windowOf(o) },
    { title: "Turns", value: String(o.samples) },
  ];
  return m;
}

export function digestMessage(obs: Observation[], errored: string[], narrative: string, dashboardUrl: string): AlertMessage {
  const breached = obs.filter((o) => o.status === "breached").length;
  const title = breached > 0 ? `Statusbericht: ${breached} Problem${breached === 1 ? "" : "e"}` : "Statusbericht: alles in Ordnung";
  const m = base(breached > 0 ? "ALERT" : "OK", title, narrative, dashboardUrl);
  m.window = "Statusbericht";
  m.facts = obs.map((o) => {
    const note = humanNote(o);
    return {
      title: `${o.status === "breached" ? "🔴" : o.status === "skipped" ? "⚪" : "🟢"} ${humanRuleName(o.rule.key, o.agent, o.subkey)}`,
      value: `${humanValue(o)} (erlaubt bis ${humanThreshold(o)})${note ? ` – ${note}` : ""}`,
    };
  });
  if (errored.length) m.facts.push({ title: "⚪ Nicht prüfbar", value: `${errored.map(humanErrored).join(", ")} (die Daten konnten nicht geladen werden)` });
  return m;
}

export function testMessage(dashboardUrl: string): AlertMessage {
  return base("OK", "Testalarm", "Dies ist ein Testalarm. Alles funktioniert. Keine Aktion nötig.", dashboardUrl);
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
