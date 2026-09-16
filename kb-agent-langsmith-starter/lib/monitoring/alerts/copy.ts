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
/** Costs are an operating figure; nothing in the data says a user saw anything. */
const COST_IMPACT = "Für die Nutzer ändert sich dadurch nichts Sichtbares; es geht nur um die Kosten.";

/**
 * Subject-aware verb forms. "Beide Assistenten hat …" is the kind of sentence that makes a
 * reader stop trusting the message, so every template takes its verbs from here.
 */
export interface AgentVerbs { subject: string; title: string; hat: string; ist: string; liegt: string; antwortet: string }
export function verbs(a: ObsAgent): AgentVerbs {
  const p = a === "total";
  return {
    subject: AGENT_SUBJECT[a],
    title: AGENT_TITLE[a],
    hat: p ? "haben" : "hat",
    ist: p ? "sind" : "ist",
    liegt: p ? "liegen" : "liegt",
    antwortet: p ? "antworten" : "antwortet",
  };
}

/** "in der letzten Stunde" / "in den letzten 24 Stunden" / "in den letzten 7 Tagen" / "heute". */
export function windowPhrase(o: Observation): string {
  if (o.rule.key === "cost_daily") return "heute";
  const h = o.rule.window_hours;
  if (h >= 48 && h % 24 === 0) return `in den letzten ${h / 24} Tagen`;
  if (h === 1) return "in der letzten Stunde";
  return `in den letzten ${h} Stunden`;
}
const Window = (o: Observation) => { const w = windowPhrase(o); return w.charAt(0).toUpperCase() + w.slice(1); };

const de1 = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const de2 = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const val = (o: Observation) => humanValue(o);
const lim = (o: Observation) => humanThreshold(o);

/** "3" for a whole multiplier, "3,2" otherwise — a forced ",0" reads like false precision. */
const factor = (n: number) => (Number.isInteger(n) ? n.toLocaleString("de-DE") : de1(n));
/** Counts are spoken, not multiplied: "7-mal", never "7×" (that stays in the technical view). */
const mal = (n: number) => `${n}-mal`;

/**
 * The cost spike is a multiplier; "3,2× Basis" is jargon, "3,2-mal so hoch wie an einem
 * normalen Tag" is not. 999 is the "baseline was zero" sentinel from rules.ts and must never
 * be printed as a number — it is not a measurement.
 */
export function times(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v >= 999) return "deutlich mehr als an einem normalen Tag";
  return `${factor(v)}-mal so hoch wie an einem normalen Tag`;
}

/**
 * One number as a human reads it, by rule key — the shared primitive behind `humanValue`,
 * `humanThreshold` and the dashboard's run report (the technical view keeps `fmtValue`).
 */
export function humanNumber(key: RuleKey, v: number | null): string {
  // A skipped rule has no measurement at all; saying "deutlich mehr" there would be a claim
  // the data does not make.
  if (v === null) return "nicht gemessen";
  if (key === "cost_spike") return times(v);
  if (key === "error_repeat" || key === "partner_upstream") return mal(v);
  return fmtValue(key, v);
}
/** The same for a limit — a spike limit is a comparison, not a bare multiplier. */
export function humanLimit(key: RuleKey, v: number | null): string {
  if (v === null) return "nicht gemessen";
  if (key === "cost_spike") return `${factor(v)}-mal so hoch wie an einem normalen Tag`;
  if (key === "error_repeat" || key === "partner_upstream") return mal(v);
  return fmtValue(key, v);
}

/** The observed value as a human reads it. */
export function humanValue(o: Observation): string {
  return humanNumber(o.rule.key, o.observed);
}
/** The threshold as a human reads it. */
export function humanThreshold(o: Observation): string {
  return humanLimit(o.rule.key, o.threshold);
}

/**
 * One digest row's value. A skipped rule was never measured, so "(erlaubt bis …)" would
 * suggest a comparison that did not happen — the reason takes its place.
 */
export function humanDigestValue(o: Observation): string {
  const note = humanNote(o);
  // cost_spike's full limit phrase ("… so hoch wie an einem normalen Tag") would repeat the
  // unit the value just established; the bare factor is unambiguous right after it.
  const limit = o.rule.key === "cost_spike"
    ? `(erlaubt: bis ${Number.isInteger(o.threshold) ? String(o.threshold) : o.threshold.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}-mal)`
    : `(erlaubt bis ${humanThreshold(o)})`;
  const head = o.observed === null ? humanValue(o) : `${humanValue(o)} ${limit}`;
  return `${head}${note ? ` – ${note}` : ""}`;
}

/**
 * `rules.ts` writes engineer notes ("zu wenig Daten (0 < 10)"). They are diagnostics, not
 * sentences for the team — this translates the four it can produce and returns null for
 * anything it does not recognise, so an unknown note is dropped rather than leaked.
 */
export function humanNote(o: Observation): string | null {
  return humanNoteText(o.note);
}

/** Same translation from the raw note string — the dashboard has no `Observation` at hand. */
export function humanNoteText(raw: string | null | undefined): string | null {
  const note = (raw ?? "").trim();
  if (!note) return null;
  const warm = /^Aufwärmphase \(warmup\):\s*(\d+)\s*\/\s*(\d+)\s*Tage Basis$/.exec(note);
  if (warm) return `Noch nicht genug Vergleichstage gesammelt (${warm[1]} von ${warm[2]})`;
  if (/^zu wenig Daten \(\d+\s*<\s*\d+\)$/.test(note)) return "Zu wenige Anfragen im Zeitraum, um das zuverlässig zu beurteilen";
  if (note === "Fenster nicht geladen") return "Die Daten konnten nicht geladen werden";
  // state.ts writes this when a breached rule has no observation at all this run.
  if (note === "im Fenster nicht mehr aufgetreten") return "Im Zeitraum nicht mehr aufgetreten";
  const spike = /^24h\s+([\d.]+)\s*\$\s*vs\s*Basis\s+([\d.]+)\s*\$/.exec(note);
  if (spike) {
    const today = Number(spike[1]);
    const base = Number(spike[2]);
    if (!Number.isFinite(today) || !Number.isFinite(base)) return null;
    return `Heute ${de2(today)} $, an einem normalen Tag ${de2(base)} $`;
  }
  return null;
}

/** A known error type explains itself; an unknown one must never be guessed at. */
export function causeOfErrorType(type: string, agent: ObsAgent = "total"): string | null {
  const t = (type || "").toLowerCase();
  if (t.includes("429") || t.includes("rate_limit") || t.includes("rate-limit") || t.includes("ratelimit") || t.includes("overload")) {
    return "Die meisten Fehler kamen vom KI-Anbieter, der Anfragen abgewiesen hat, weil er zeitweise überlastet war.";
  }
  if (t.includes("timeout") || t.includes("timed_out")) return "Die Antworten kamen zu spät: der Dienst hat länger gebraucht, als er darf.";
  if (t.includes("unavailable") || t.includes("upstream")) {
    // Only the partner search is known to depend on an external service; for the FAQ
    // assistant (or for both at once) the data does not say which service it was.
    return agent === "partner"
      ? "Die Partner-Suche war in dieser Zeit nicht erreichbar."
      : "Ein benötigter Dienst war in dieser Zeit nicht erreichbar.";
  }
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
    impact: () => COST_IMPACT,
    next: () => COST_NEXT,
    recovered: (o) => `Die Kosten ${AGENT_FOR[o.agent]} liegen heute bei ${val(o)}, die Obergrenze liegt bei ${lim(o)}. Die Kosten liegen wieder im geplanten Rahmen.`,
  },
  cost_spike: {
    title: (o) => `${AGENT_TITLE[o.agent]}: Kosten deutlich gestiegen`,
    titleOk: (o) => `Entwarnung: Kosten ${AGENT_GENITIVE[o.agent]} wieder wie üblich`,
    what: (o) => `Die Kosten ${AGENT_FOR[o.agent]} sind ${windowPhrase(o)} ${times(o.observed)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => COST_IMPACT,
    next: () => COST_NEXT,
    recovered: (o) => `Die Kosten ${AGENT_FOR[o.agent]} sind wieder auf dem üblichen Niveau: noch ${times(o.observed)}. Der Anstieg war vorübergehend.`,
  },
  failure_rate: {
    title: (o) => `${AGENT_TITLE[o.agent]}: viele Anfragen ohne Antwort`,
    titleOk: (o) => `Entwarnung: ${AGENT_TITLE[o.agent]} ${verbs(o.agent).antwortet} wieder`,
    what: (o) => `${verbs(o.agent).subject} ${verbs(o.agent).hat} ${windowPhrase(o)} bei ${val(o)} der Anfragen keine Antwort geliefert; normal wären höchstens ${lim(o)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Betroffene Nutzer haben keine brauchbare Antwort bekommen.",
    next: () => ERRORS_NEXT,
    recovered: (o) => `${verbs(o.agent).subject} ${verbs(o.agent).hat} ${windowPhrase(o)} nur noch bei ${val(o)} der Anfragen nicht geantwortet und ${verbs(o.agent).liegt} damit wieder im normalen Bereich. Die Nutzer bekommen wieder ihre Antworten.`,
  },
  latency_p95: {
    title: (o) => `${AGENT_TITLE[o.agent]}: Antworten dauern zu lange`,
    titleOk: (o) => `Entwarnung: ${AGENT_TITLE[o.agent]} ${verbs(o.agent).antwortet} wieder schnell`,
    what: (o) => `${verbs(o.agent).subject} ${verbs(o.agent).hat} ${windowPhrase(o)} für die langsamsten Anfragen ${val(o)} gebraucht; vorgesehen sind höchstens ${lim(o)}.`,
    why: () => UNKNOWN_CAUSE,
    impact: () => "Betroffene Nutzer mussten ungewöhnlich lange auf eine Antwort warten und haben womöglich vorher abgebrochen.",
    next: () => TELL_TECH,
    recovered: (o) => `${verbs(o.agent).subject} ${verbs(o.agent).ist} wieder schnell: die langsamsten Anfragen dauerten ${windowPhrase(o)} noch ${val(o)}. Die Nutzer warten wieder normal lange.`,
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
    why: (o) => causeOfErrorType(o.subkey, o.agent) ?? UNKNOWN_CAUSE,
    impact: () => "Betroffene Nutzer haben statt einer Antwort eine Fehlermeldung gesehen.",
    next: () => ERRORS_NEXT,
    // "tritt nicht mehr auf" claimed more than the data says: the rule only fell back under its
    // reporting limit, and it may still have happened a few times.
    recovered: (o) => {
      const gone = o.observed === null || o.observed === 0;
      const body = gone
        ? `${windowPhrase(o)} nicht mehr aufgetreten.`
        : `${windowPhrase(o)} nur noch ${val(o)} aufgetreten; gemeldet wird ab ${lim(o)}.`;
      return `Der wiederholte Fehler ${AGENT_AT[o.agent]} ist ${body} Die Nutzer bekommen wieder ihre Antworten.`;
    },
  },
  partner_upstream: {
    title: () => "Partner-Suche: zeitweise nicht erreichbar",
    titleOk: () => "Entwarnung: Partner-Suche wieder erreichbar",
    what: (o) => `Die Partner-Suche war ${windowPhrase(o)} ${val(o)} nicht erreichbar; ab ${lim(o)} melden wir das.`,
    why: () => "Der Dienst hinter der Partner-Suche hat in dieser Zeit nicht geantwortet.",
    impact: () => "Betroffene Nutzer haben auf die Frage nach Studios oder Kursen keine Ergebnisse bekommen.",
    next: () => "Bitte das Technik-Team informieren, damit es die Partner-Suche prüft.",
    // Same honesty problem as the repeated error: "wieder erreichbar" hid how often it still was not.
    recovered: (o) => {
      const gone = o.observed === null || o.observed === 0;
      const body = gone
        ? `war ${windowPhrase(o)} durchgehend erreichbar.`
        : `war ${windowPhrase(o)} nur noch ${val(o)} nicht erreichbar; gemeldet wird ab ${lim(o)}.`;
      return `Die Partner-Suche ${body} Nutzer bekommen wieder Studios und Kurse angezeigt.`;
    },
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
  const who = AGENT_HUMAN[agent === "faq" || agent === "partner" ? agent : "total"];
  return `${metric} (${who})`;
}

/** Headline of the Teams card / email subject. */
export function humanHeadline(kind: "fired" | "recovered", o: Observation): string {
  const h = HUMAN[o.rule.key];
  return kind === "recovered" ? h.titleOk(o) : h.title(o);
}
