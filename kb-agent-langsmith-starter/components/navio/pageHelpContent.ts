// Page-specific help CONTENT — a plain TS module (no JSX) so tests can pin
// the copy contract without a JSX transform. The overlay that renders it
// lives in PageHelp.tsx.

/** Screens that have a manual. Keyed by the widget's `Screen` values. */
export type HelpScreen = "menu" | "chat" | "partner";

export interface PageHelpEntry {
  /** Panel heading, bilingual on one line. */
  title: string;
  /** German explanation — one short paragraph, then optional bullets. */
  de: string[];
  /** English mirror of the same content. */
  en: string[];
}

/**
 * The manuals. Each entry describes ONLY its own page: what it is for and how
 * to use it. Keep every entry scannable — a visitor reads this mid-task.
 */
export const PAGE_HELP: Record<HelpScreen, PageHelpEntry> = {
  menu: {
    title: "Das Navio Menü · The Navio menu",
    de: [
      "Hier wählst du aus, wie Navio dir helfen soll:",
      "FAQ-Agent — beantwortet allgemeine Fragen zu Sportnavi, sofort.",
      "Partner finden — sucht Studios & Kurse in einer bestimmten Stadt.",
      "Kontaktformular — schreib unserem Team; wir melden uns zurück.",
      "Termin buchen — öffnet die Terminbuchung in einem neuen Tab.",
      "Unten findest du außerdem direkte Links zu sportnavi.de.",
    ],
    en: [
      "This menu is where you choose how Navio helps you:",
      "FAQ agent — instant answers to general Sportnavi questions.",
      "Find partners — searches studios & courses in a specific city.",
      "Contact form — write to our team; we get back to you.",
      "Book appointment — opens scheduling in a new tab.",
      "Below you also find direct links to sportnavi.de.",
    ],
  },
  chat: {
    title: "FAQ-Agent · FAQ agent",
    de: [
      "Diese Seite ist für allgemeine Fragen rund um Sportnavi da — z. B. Tarife, Check-in, Cashback oder Verträge. Du bekommst sofort eine Antwort.",
      "Schreib einfach in deiner Sprache — Navio versteht und antwortet in jeder Sprache.",
    ],
    en: [
      "This page is for general questions about Sportnavi — e.g. tariffs, check-in, cashback or contracts. You get an answer right away.",
      "Just write in your own language — Navio understands and answers in any language.",
    ],
  },
  partner: {
    title: "Partner-Finder · Partner finder",
    de: [
      "Diese Seite findet Sportnavi-Partner in einer bestimmten Stadt.",
      "Sag mir dafür zwei Dinge: die Stadt und was du suchst — z. B. „Yoga in Bochum“ oder „Fitnessstudio in Bielefeld“.",
      "Ohne eine Stadt kann ich nicht suchen — die Suche ist immer stadtbezogen.",
    ],
    en: [
      "This page finds Sportnavi partners in a specific city.",
      "Tell me two things: the city and what you are looking for — e.g. “yoga in Bochum” or “gym in Bielefeld”.",
      "Without a city I cannot search — results are always city-specific.",
    ],
  },
};
