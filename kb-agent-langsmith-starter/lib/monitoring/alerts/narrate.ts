// lib/monitoring/alerts/narrate.ts — the LLM phrases; rules decided (spec §6).
// Every number the model may use is pre-formatted here and passed as JSON, together with a
// ready-made German draft (copy.ts) that it may only rephrase; the fixed system prompt forbids
// inventing numbers or using technical identifiers. Any failure ⇒ the template is used as is.
import type { LanguageModel } from "ai";
import type { Observation, ObsAgent, RuleKey, Transition } from "./types";
import { fmtValue } from "./format";
import { AGENT_HUMAN, HUMAN, NO_ACTION, humanErrored, humanHeadline, humanNote, humanRuleName, humanThreshold, humanValue, windowPhrase } from "./copy";

export interface NarrateDeps {
  generate?: (prompt: { system: string; user: string }) => Promise<string>;
  timeoutMs?: number;
}
export interface Narrative { text: string; source: "llm" | "template" }

const AGENT_LABEL: Record<ObsAgent, string> = { faq: "FAQ", partner: "Partner", total: "Gesamt" };
/** Technical labels — the "Für das Technik-Team" block and the rule editor only. */
const RULE_LABEL: Record<RuleKey, string> = {
  cost_daily: "Tageskosten", cost_spike: "Kostenanstieg", failure_rate: "Fehlerrate", latency_p95: "Antwortzeit p95",
  negative_feedback: "Negatives Feedback", error_repeat: "Wiederholter Fehler", partner_upstream: "Partner-Agent nicht erreichbar",
};

export { fmtValue };
export { humanErrored, humanHeadline, humanRuleName } from "./copy";

export const fmtObserved = (o: Observation) => fmtValue(o.rule.key, o.observed);
export const fmtThreshold = (o: Observation) => fmtValue(o.rule.key, o.threshold);

export function ruleTitle(key: RuleKey, agent: ObsAgent, subkey: string): string {
  const base = key === "error_repeat" && subkey ? `${RULE_LABEL[key]} ${subkey}` : RULE_LABEL[key];
  return `${base} · ${AGENT_LABEL[agent]}`;
}

/** what · why · impact · next — the four parts every human alert must state, in that order. */
export interface Draft { what: string; why?: string; impact?: string; next: string }

export function draftTransition(t: Transition): Draft {
  const o = t.obs;
  const h = HUMAN[o.rule.key];
  if (t.kind === "recovered") return { what: h.recovered(o), next: NO_ACTION };
  return { what: h.what(o), why: h.why(o), impact: h.impact(o), next: h.next(o) };
}

export function templateTransition(t: Transition): string {
  const d = draftTransition(t);
  return [d.what, d.why, d.impact, d.next].filter(Boolean).join(" ");
}

export function digestLine(o: Observation): string {
  const mark = o.status === "breached" ? "🔴" : o.status === "skipped" ? "⚪" : "🟢";
  const note = humanNote(o);
  return `${mark} ${humanRuleName(o.rule.key, o.agent, o.subkey)}: ${humanValue(o)} (erlaubt bis ${humanThreshold(o)})${note ? ` – ${note}` : ""}`;
}

export function templateDigest(obs: Observation[], errored: string[]): string {
  const breached = obs.filter((o) => o.status === "breached").length;
  const unchecked = errored.length > 0 || obs.some((o) => o.status === "skipped");
  const head = breached > 0
    ? `Achtung: ${breached} Problem${breached === 1 ? "" : "e"} gefunden.`
    : unchecked
      ? "Keine Probleme gefunden — einzelne Werte konnten aber nicht geprüft werden."
      : "Alles in Ordnung: beide Assistenten laufen normal, die Kosten sind im Rahmen.";
  const lines = obs.map(digestLine);
  const err = errored.map((e) => `Nicht prüfbar: ${humanErrored(e)} (die Daten konnten nicht geladen werden)`);
  return [head, ...lines, ...err].join("\n");
}

const SYSTEM = [
  "Du schreibst kurze Statusmeldungen für das Team von Sportnavi, das den Navio-Chatbot betreut.",
  "Die Leser sind keine Technikerinnen und Techniker.",
  "Sprache: Deutsch, einfache kurze Sätze, kein Markdown, keine Aufzählungszeichen, keine Überschriften, keine Entschuldigungen.",
  "Schreibe bei einem Alarm genau vier Teile in dieser Reihenfolge, ohne Beschriftungen: erstens was passiert ist, zweitens warum (nur wenn der Entwurf eine Ursache nennt, sonst dass die Ursache noch nicht bekannt ist), drittens was das für die Nutzer bedeutet, viertens was jetzt zu tun ist.",
  "Der letzte Satz ist immer der Handlungsschritt aus dem Entwurf.",
  "Formuliere den Entwurf im Feld draft nur um; erfinde nichts dazu und lass nichts weg.",
  "Verwende ausschließlich die Zahlen aus dem JSON, keine weiteren.",
  "Keine technischen Bezeichnungen, keine Fehlercodes, keine Abkürzungen, keine Regelnamen, keine Kennungen.",
  "Ein Alarm hat 60 bis 120 Wörter.",
  "Eine Entwarnung sind zwei bis drei Sätze und endet mit dem Satz: Keine Aktion nötig.",
  "Beim Statusbericht: zuerst ein Satz zur Gesamtlage, dann je eine kurze Zeile pro Regel in einfachen Worten, höchstens 120 Wörter.",
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

/**
 * Last line of defence: the model is told not to use identifiers, but a prompt is not a
 * guarantee. If jargon reaches the text, the deterministic template is used instead.
 */
const TECHNICAL_LEAK = /[a-z_]+·(faq|partner|total)|failure_rate|latency_p95|cost_(daily|spike)|error_repeat|partner_upstream|HTTP \d|\bp95\b|warmup|\d+ ?< ?\d+/i;

async function run(user: Record<string, unknown>, fallback: string, deps: NarrateDeps): Promise<Narrative> {
  const generate = deps.generate ?? defaultGenerate;
  try {
    const text = await withTimeout(generate({ system: SYSTEM, user: JSON.stringify(user) }), deps.timeoutMs ?? 8000);
    if (!text || text.length > 1200 || TECHNICAL_LEAK.test(text)) return { text: fallback, source: "template" };
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
    headline: humanHeadline(t.kind, o),
    metric: humanRuleName(o.rule.key, o.agent, o.subkey),
    agent: AGENT_HUMAN[o.agent],
    observed: fmtObserved(o), threshold: fmtThreshold(o),
    samples: o.samples, window: windowPhrase(o),
    note: humanNote(o),
    draft: draftTransition(t),
  }, templateTransition(t), deps);
}

export function narrateDigest(obs: Observation[], errored: string[], deps: NarrateDeps = {}): Promise<Narrative> {
  return run({
    kind: "statusbericht",
    rules: obs.map((o) => ({ metric: humanRuleName(o.rule.key, o.agent, o.subkey), status: o.status === "breached" ? "Problem" : o.status === "skipped" ? "nicht geprüft" : "in Ordnung", observed: humanValue(o), threshold: humanThreshold(o), note: humanNote(o) })),
    not_evaluable: errored.map(humanErrored),
    draft: templateDigest(obs, errored),
  }, templateDigest(obs, errored), deps);
}
