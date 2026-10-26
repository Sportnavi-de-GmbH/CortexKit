// Page-specific help CONTENT — a plain TS module (no JSX) so tests can pin
// the copy contract without a JSX transform. The overlay that renders it
// lives in PageHelp.tsx.

/** Screens that have a manual. Keyed by the widget's `Screen` values. */
export type HelpScreen = "chat" | "partner";

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
  chat: {
    title: "FAQ-Agent · FAQ agent",
    de: [
      "Diese Seite ist für allgemeine Fragen rund um Sportnavi da — z. B. Tarife, Check-in, Cashback oder Verträge. Du bekommst sofort eine Antwort.",
      "Schreib einfach in deiner Sprache — Navio versteht und antwortet in jeder Sprache.",
      "Unten findest du direkte Links zu sportnavi.de — FAQ, Studios, Kontakt, Über uns und Datenschutz.",
    ],
    en: [
      "This page is for general questions about Sportnavi — e.g. tariffs, check-in, cashback or contracts. You get an answer right away.",
      "Just write in your own language — Navio understands and answers in any language.",
      "Below you find direct links to sportnavi.de — FAQ, studios, contact, about us and privacy.",
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
