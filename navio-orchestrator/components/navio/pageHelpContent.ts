// Page-specific help CONTENT — a plain TS module (no JSX) so tests can pin
// the copy contract without a JSX transform. The overlay that renders it
// lives in PageHelp.tsx. Ported from kb-agent-langsmith-starter, adapted to
// the orchestrator's chat-first design: there is ONE conversation, so there
// is one manual, and it describes everything that chat can do.

/** Screens that have a manual. Keyed by the widget's `Screen` values. */
export type HelpScreen = "chat";

export interface PageHelpEntry {
  /** Panel heading, bilingual on one line. */
  title: string;
  /** German explanation — one short paragraph, then optional bullets. */
  de: string[];
  /** English mirror of the same content. */
  en: string[];
}

/**
 * The manual. Keep it scannable — a visitor reads this mid-task. The DE and EN
 * blocks mirror each other line for line (pinned by tests/page-help.test.ts).
 */
export const PAGE_HELP: Record<HelpScreen, PageHelpEntry> = {
  chat: {
    title: "Der Navio Chat · The Navio chat",
    de: [
      "Hier erledigst du alles in einem Chat — frag einfach in deinen eigenen Worten:",
      "Allgemeine Fragen zu Sportnavi — z. B. Tarife, Check-in, Cashback oder Verträge. Du bekommst sofort eine Antwort.",
      "Studios & Kurse finden — nenn mir die Stadt und was du suchst, z. B. „Yoga in Bochum“. Die Suche ist immer stadtbezogen.",
      "Kontakt zum Team — über die Buttons unter jeder Antwort erreichst du das Kontaktformular und die Terminbuchung.",
      "Schreib in deiner Sprache — Navio versteht und antwortet in jeder Sprache.",
    ],
    en: [
      "Everything happens in this one chat — just ask in your own words:",
      "General questions about Sportnavi — e.g. tariffs, check-in, cashback or contracts. You get an answer right away.",
      "Find studios & courses — tell me the city and what you are looking for, e.g. “yoga in Bochum”. Results are always city-specific.",
      "Reach the team — the buttons under every answer open the contact form and appointment booking.",
      "Write in your own language — Navio understands and answers in any language.",
    ],
  },
};
