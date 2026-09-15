// lib/monitoring/alerts/narrate.ts — the LLM phrases; rules decided (spec §6).
// Every number the model may use is pre-formatted here and passed as JSON; the
// fixed system prompt forbids inventing others. Any failure ⇒ template.
import type { LanguageModel } from "ai";
import type { Observation, ObsAgent, RuleKey, Transition } from "./types";

export interface NarrateDeps {
  generate?: (prompt: { system: string; user: string }) => Promise<string>;
  timeoutMs?: number;
}
export interface Narrative { text: string; source: "llm" | "template" }

const AGENT_LABEL: Record<ObsAgent, string> = { faq: "FAQ", partner: "Partner", total: "Gesamt" };
const RULE_LABEL: Record<RuleKey, string> = {
  cost_daily: "Tageskosten", cost_spike: "Kostenanstieg", failure_rate: "Fehlerrate", latency_p95: "Antwortzeit p95",
  negative_feedback: "Negatives Feedback", error_repeat: "Wiederholter Fehler", partner_upstream: "Partner-Agent nicht erreichbar",
};
const FIRST_CHECK: Record<RuleKey, string> = {
  cost_daily: "Die teuersten Traces des Tages unter /monitoring nach Kosten prüfen.",
  cost_spike: "Prüfen, ob Traffic oder Antwortlänge gestiegen ist (Traces der letzten 24 h).",
  failure_rate: "Die neuesten Fehler unter /monitoring prüfen (Azure 429, Timeouts).",
  latency_p95: "Langsame Traces öffnen und den langsamsten Schritt prüfen (Modell oder Partner-Suche).",
  negative_feedback: "Die 👎-Antworten in der Review-Queue lesen.",
  error_repeat: "Die Fehlermeldung in den neuesten Traces öffnen.",
  partner_upstream: "Deployment und PARTNER_AGENT_HOST des Partner-Agents prüfen.",
};

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
export const fmtObserved = (o: Observation) => fmtValue(o.rule.key, o.observed);
export const fmtThreshold = (o: Observation) => fmtValue(o.rule.key, o.threshold);

export function ruleTitle(key: RuleKey, agent: ObsAgent, subkey: string): string {
  const base = key === "error_repeat" && subkey ? `${RULE_LABEL[key]} ${subkey}` : RULE_LABEL[key];
  return `${base} · ${AGENT_LABEL[agent]}`;
}

export function templateTransition(t: Transition): string {
  const o = t.obs;
  const title = ruleTitle(o.rule.key, o.agent, o.subkey);
  const win = o.rule.key === "cost_daily" ? "heute" : `${o.rule.window_hours} h`;
  if (t.kind === "recovered") return `${title} ist wieder im grünen Bereich: ${fmtObserved(o)} (Grenze ${fmtThreshold(o)}, Fenster ${win}).`;
  const samples = o.samples ? ` bei ${o.samples} Turns` : "";
  return `${title}: ${fmtObserved(o)}${samples} in den letzten ${win}, Grenze ${fmtThreshold(o)}. ${FIRST_CHECK[o.rule.key]}`;
}

export function templateDigest(obs: Observation[], errored: string[]): string {
  const breached = obs.filter((o) => o.status === "breached");
  const head = breached.length === 0 ? "Alles im grünen Bereich." : `${breached.length} Regel(n) verletzt.`;
  const lines = obs.map((o) => `${o.status === "breached" ? "🔴" : o.status === "skipped" ? "⚪" : "🟢"} ${ruleTitle(o.rule.key, o.agent, o.subkey)}: ${fmtObserved(o)} (Grenze ${fmtThreshold(o)})${o.note ? ` – ${o.note}` : ""}`);
  const err = errored.length ? `\n⚠️ Nicht auswertbar: ${errored.join(", ")}` : "";
  return `${head}\n${lines.join("\n")}${err}`;
}

const SYSTEM = [
  "Du schreibst kurze Statusmeldungen für das Team, das den Navio-Chatbot betreibt.",
  "Sprache: Deutsch, einfache Sätze, kein Markdown, keine Überschriften, keine Entschuldigungen.",
  "Benutze ausschließlich die Zahlen und Bezeichnungen aus dem JSON. Erfinde keine weiteren Zahlen.",
  "Bei einem Alarm: nenne Agent, Metrik, beobachteten Wert, Grenze und Zeitfenster; schließe mit genau einem konkreten ersten Prüfschritt (aus first_check).",
  "Bei einer Entwarnung: ein Satz, dass der Wert wieder unter der Grenze liegt.",
  "Beim Digest: zwei bis vier Sätze Gesamtlage, verletzte Regeln zuerst; wenn alles ok ist, sag das knapp.",
  "Maximal 120 Wörter.",
].join(" ");

async function defaultGenerate(p: { system: string; user: string }): Promise<string> {
  const { generateText } = await import("ai");
  const { getAzureChatModel } = await import("../../llm");
  const model: LanguageModel = getAzureChatModel();
  const r = await generateText({ model, system: p.system, prompt: p.user, maxOutputTokens: 400, temperature: 0.2 });
  return r.text.trim();
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error("narrate timeout")), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run(user: Record<string, unknown>, fallback: string, deps: NarrateDeps): Promise<Narrative> {
  const generate = deps.generate ?? defaultGenerate;
  try {
    const text = await withTimeout(generate({ system: SYSTEM, user: JSON.stringify(user) }), deps.timeoutMs ?? 8000);
    if (!text || text.length > 1200) return { text: fallback, source: "template" };
    return { text, source: "llm" };
  } catch {
    return { text: fallback, source: "template" };
  }
}

export function narrateTransition(t: Transition, deps: NarrateDeps = {}): Promise<Narrative> {
  const o = t.obs;
  return run({
    kind: t.kind === "fired" ? "alarm" : "entwarnung",
    severity: o.rule.severity,
    metric: ruleTitle(o.rule.key, o.agent, o.subkey),
    observed: fmtObserved(o), threshold: fmtThreshold(o),
    samples: o.samples, window: o.rule.key === "cost_daily" ? "heute (Berlin)" : `${o.rule.window_hours} h`,
    note: o.note ?? null, first_check: FIRST_CHECK[o.rule.key],
  }, templateTransition(t), deps);
}

export function narrateDigest(obs: Observation[], errored: string[], deps: NarrateDeps = {}): Promise<Narrative> {
  return run({
    kind: "digest",
    rules: obs.map((o) => ({ metric: ruleTitle(o.rule.key, o.agent, o.subkey), status: o.status, observed: fmtObserved(o), threshold: fmtThreshold(o), note: o.note ?? null })),
    not_evaluable: errored,
  }, templateDigest(obs, errored), deps);
}
