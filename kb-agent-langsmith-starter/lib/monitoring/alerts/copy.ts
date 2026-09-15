// lib/monitoring/alerts/copy.ts — the human wording of every alert. The Sportnavi team is not
// technical, so nothing here may contain a rule key, an agent id, an error code or a metric
// abbreviation; those belong in the "Für das Technik-Team" block instead.
// Every rule answers the same four questions: what happened, why, what it meant for the users,
// what to do now.
import type { Observation, ObsAgent, RuleKey } from "./types";
import { fmtValue } from "./format";

export const AGENT_HUMAN: Record<ObsAgent, string> = { faq: "FAQ-Assistent", partner: "Partner-Suche", total: "beide Assistenten" };
const AGENT_TITLE: Record<ObsAgent, string> = { faq: "FAQ-Assistent", partner: "Partner-Suche", total: "Beide Assistenten" };
const AGENT_SUBJECT: Record<ObsAgent, string> = { faq: "Der FAQ-Assistent", partner: "Die Partner-Suche", total: "Beide Assistenten" };
const AGENT_GENITIVE: Record<ObsAgent, string> = { faq: "des FAQ-Assistenten", partner: "der Partner-Suche", total: "beider Assistenten" };
const AGENT_AT: Record<ObsAgent, string> = { faq: "beim FAQ-Assistenten", partner: "bei der Partner-Suche", total: "bei beiden Assistenten" };
const AGENT_FOR: Record<ObsAgent, string> = { faq: "für den FAQ-Assistenten", partner: "für die Partner-Suche", total: "für beide Assistenten" };

/** Plain-language name of the measured thing — never the rule key. */
export const METRIC_HUMAN: Record<RuleKey, string> = {
  cost_daily: "Tageskosten",
  cost_spike: "Kostenanstieg",
  failure_rate: "Fehlerrate",
  latency_p95: "Antwortzeit",
  negative_feedback: "Negative Bewertungen",
  error_repeat: "Wiederholte Fehler",
  partner_upstream: "Erreichbarkeit",
};

export const UNKNOWN_CAUSE = "Die Ursache ist noch nicht bekannt.";
export const NO_ACTION = "Keine Aktion nötig.";
const TELL_TECH = "Bitte das Technik-Team informieren, falls die Meldung morgen erneut kommt.";
const COST_NEXT = "Bitte im Monitoring prüfen, ob ungewöhnlich viele Anfragen kamen, und ggf. das Technik-Team informieren.";
const ERRORS_NEXT = "Bitte im Monitoring unter 'Neueste Fehler' nachsehen und, falls es weiter auftritt, das Technik-Team informieren.";

const plural = (a: ObsAgent) => a === "total";
const hat = (a: ObsAgent) => (plural(a) ? "haben" : "hat");
const ist = (a: ObsAgent) => (plural(a) ? "sind" : "ist");

/** "in den letzten 24 Stunden" / "in den letzten 7 Tagen" / "heute". */
export function windowPhrase(o: Observation): string {
  if (o.rule.key === "cost_daily") return "heute";
  const h = o.rule.window_hours;
  if (h >= 48 && h % 24 === 0) return `in den letzten ${h / 24} Tagen`;
  return `in den letzten ${h} Stunden`;
}
const Window = (o: Observation) => { const w = windowPhrase(o); return w.charAt(0).toUpperCase() + w.slice(1); };

const val = (o: Observation) => fmtValue(o.rule.key, o.observed);
const lim = (o: Observation) => fmtValue(o.rule.key, o.threshold);
/** The cost spike is a multiplier; "3,2x Basis" is jargon, "3,2-mal so hoch" is not. */
const times = (v: number | null) => (v === null ? "deutlich mehr" : `${v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}-mal so hoch`);

/** A known error type explains itself; an unknown one must never be guessed at. */
export function causeOfErrorType(type: string): string | null {
  const t = (type || "").toLowerCase();
  if (t.includes("429") || t.includes("rate_limit") || t.includes("rate-limit") || t.includes("ratelimit") || t.includes("overload")) {
    return "Die meisten Fehler kamen vom KI-Anbieter, der Anfragen abgewiesen hat, weil er zeitweise überlastet war.";
  }
  if (t.includes("timeout") || t.includes("timed_out")) return "Die Antworten kamen zu spät: der Dienst hat länger gebraucht, als er darf.";
  if (t.includes("unavailable") || t.includes("upstream")) return "Die Partner-Suche war in dieser Zeit nicht erreichbar.";
  return null;
}

export interface HumanRule {
  /** Card headline while the rule is breached. */
  title(o: Observation): string;
  /** Card headline for the all-clear. */
  titleOk(o: Observation): string;
  what(o: Observation): string;
  why(o: Observation): string;
  impact(o: Observation): string;
  next(o: Observation): string;
  /** Two sentences for the all-clear; the template appends "Keine Aktion nötig." */
  recovered(o: Observation): string;
}

export const HUMAN: Record<RuleKey, HumanRule> = {
  cost_daily: {
    title: (o) => `${AGENT_TITLE[o.agent]}: Tagesbudget überschritten`,
    titleOk: (o) => `Entwarnung: Kosten ${AGENT_GENITIVE[o.agent]} wieder im Rahmen`,
    what: (o) => `Die Kosten ${AGENT_FOR[o.agent]} liegen heute bei ${val(o)} und damit über dem geplanten Tagesbudget von ${lim(o)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Der Chatbot hat weiter normal geantwortet, der Betrieb war heute nur teurer als geplant.",
    next: () => COST_NEXT,
    recovered: (o) => `Die Kosten ${AGENT_FOR[o.agent]} liegen heute wieder im geplanten Rahmen: ${val(o)} statt der Obergrenze von ${lim(o)}. Es entstehen keine zusätzlichen Kosten mehr.`,
  },
  cost_spike: {
    title: (o) => `${AGENT_TITLE[o.agent]}: Kosten deutlich gestiegen`,
    titleOk: (o) => `Entwarnung: Kosten ${AGENT_GENITIVE[o.agent]} wieder wie üblich`,
    what: (o) => `Die Kosten ${AGENT_FOR[o.agent]} sind ${windowPhrase(o)} ${times(o.observed)} wie an einem normalen Tag.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Der Chatbot hat weiter normal geantwortet, der Betrieb war in dieser Zeit nur teurer als üblich.",
    next: () => COST_NEXT,
    recovered: (o) => `Die Kosten ${AGENT_FOR[o.agent]} sind wieder auf dem üblichen Niveau. Der Anstieg war vorübergehend.`,
  },
  failure_rate: {
    title: (o) => `${AGENT_TITLE[o.agent]}: viele Anfragen ohne Antwort`,
    titleOk: (o) => `Entwarnung: ${AGENT_TITLE[o.agent]} antwortet wieder`,
    what: (o) => `${AGENT_SUBJECT[o.agent]} ${hat(o.agent)} ${windowPhrase(o)} bei ${val(o)} der Anfragen keine Antwort geliefert; normal wären höchstens ${lim(o)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Betroffene Nutzer haben eine Fehlermeldung statt einer Antwort gesehen.",
    next: () => ERRORS_NEXT,
    recovered: (o) => `${AGENT_SUBJECT[o.agent]} ${hat(o.agent)} ${windowPhrase(o)} nur noch bei ${val(o)} der Anfragen nicht geantwortet und liegt damit wieder im normalen Bereich. Die Nutzer bekommen wieder ihre Antworten.`,
  },
  latency_p95: {
    title: (o) => `${AGENT_TITLE[o.agent]}: Antworten dauern zu lange`,
    titleOk: (o) => `Entwarnung: ${AGENT_TITLE[o.agent]} antwortet wieder schnell`,
    what: (o) => `${AGENT_SUBJECT[o.agent]} ${hat(o.agent)} ${windowPhrase(o)} für die langsamsten Anfragen ${val(o)} gebraucht; vorgesehen sind höchstens ${lim(o)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Betroffene Nutzer mussten ungewöhnlich lange auf eine Antwort warten und haben womöglich vorher abgebrochen.",
    next: () => TELL_TECH,
    recovered: (o) => `${AGENT_SUBJECT[o.agent]} ${ist(o.agent)} wieder schnell: die langsamsten Anfragen dauerten ${windowPhrase(o)} noch ${val(o)}. Die Nutzer warten wieder normal lange.`,
  },
  negative_feedback: {
    title: (o) => `${AGENT_TITLE[o.agent]}: viele schlechte Bewertungen`,
    titleOk: (o) => `Entwarnung: Bewertungen ${AGENT_GENITIVE[o.agent]} wieder im Rahmen`,
    what: (o) => `${Window(o)} wurden ${val(o)} der bewerteten Antworten ${AGENT_GENITIVE[o.agent]} mit Daumen runter bewertet; üblich sind höchstens ${lim(o)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Die Antworten treffen offenbar nicht das, was die Nutzer erwartet haben.",
    next: () => "Bitte die negativ bewerteten Antworten im Monitoring durchlesen und auffällige Themen an das Technik-Team melden.",
    recovered: (o) => `Die Bewertungen ${AGENT_GENITIVE[o.agent]} sind wieder im normalen Rahmen: nur noch ${val(o)} Daumen runter. Die Nutzer kommen mit den Antworten wieder zurecht.`,
  },
  error_repeat: {
    title: (o) => `${AGENT_TITLE[o.agent]}: derselbe Fehler tritt wiederholt auf`,
    titleOk: (o) => `Entwarnung: ${AGENT_TITLE[o.agent]} ohne wiederholte Fehler`,
    what: (o) => `${Window(o)} ist ${AGENT_AT[o.agent]} ${val(o)} derselbe Fehler aufgetreten; ab ${lim(o)} melden wir das.`,
    why: (o) => causeOfErrorType(o.subkey) ?? UNKNOWN_CAUSE,
    impact: () => "Betroffene Nutzer haben statt einer Antwort eine Fehlermeldung gesehen.",
    next: () => ERRORS_NEXT,
    recovered: (o) => `Der wiederholte Fehler ${AGENT_AT[o.agent]} tritt nicht mehr auf. Die Nutzer bekommen wieder ihre Antworten.`,
  },
  partner_upstream: {
    title: () => "Partner-Suche: zeitweise nicht erreichbar",
    titleOk: () => "Entwarnung: Partner-Suche wieder erreichbar",
    what: (o) => `Die Partner-Suche war ${windowPhrase(o)} ${val(o)} nicht erreichbar; ab ${lim(o)} melden wir das.`,
    why: () => "Der Dienst hinter der Partner-Suche hat in dieser Zeit nicht geantwortet.",
    impact: () => "Betroffene Nutzer haben auf die Frage nach Studios oder Kursen keine Ergebnisse bekommen.",
    next: () => "Bitte das Technik-Team informieren, damit es die Partner-Suche prüft.",
    recovered: () => "Die Partner-Suche ist wieder erreichbar. Nutzer bekommen wieder Studios und Kurse angezeigt.",
  },
};

/** "Fehlerrate des FAQ-Assistenten" — the name a human sees in the feed and the run report. */
export function humanRuleName(key: RuleKey | string, agent: ObsAgent | string | null, _subkey = ""): string {
  const metric = METRIC_HUMAN[key as RuleKey];
  if (!metric) return String(key);
  const a: ObsAgent = agent === "faq" || agent === "partner" ? agent : "total";
  return `${metric} ${AGENT_GENITIVE[a]}`;
}

/** Turns an errored entry ("failure_rate<dot>faq") into words; unknown input is returned as is. */
export function humanErrored(entry: string): string {
  const [key, agent] = String(entry).split("·");
  const metric = METRIC_HUMAN[key as RuleKey];
  if (!metric) return String(entry);
  const who = agent === "faq" ? "FAQ-Assistent" : agent === "partner" ? "Partner-Suche" : "alle Assistenten";
  return `${metric} (${who})`;
}

/** Headline of the Teams card / email subject. */
export function humanHeadline(kind: "fired" | "recovered", o: Observation): string {
  const h = HUMAN[o.rule.key];
  return kind === "recovered" ? h.titleOk(o) : h.title(o);
}
