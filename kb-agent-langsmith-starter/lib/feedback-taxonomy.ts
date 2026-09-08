// The ONE source of truth for the feedback vocabulary — visitor reason codes
// AND reviewer verdicts. Plain data, client-safe (imported by the browser
// component, the server feedback module, the setup script and the tests), so
// the widget's reason buttons and the server's accepted taxonomy can never
// drift apart again (they used to be two hand-synced lists).
//
// Changing a CODE here is a breaking change to the Langfuse CATEGORICAL score
// configs, which cannot be edited or deleted once created — add new codes,
// never rename existing ones.

/**
 * Why a visitor pressed 👎. Each code carries:
 *  - `de` / `en`  — the bilingual button copy the widget renders;
 *  - `correlate`  — the objective trace metric that should agree with the
 *    subjective complaint. This is what turns "users are unhappy" into
 *    "users are unhappy AND here is the metric that agrees with them".
 */
export const REASONS = [
  {
    code: "too_slow",
    de: "Zu langsam",
    en: "Too slow",
    correlate: "timing.duration_ms · timing.first_token_ms",
  },
  {
    code: "not_relevant",
    de: "Nicht relevant",
    en: "Not relevant",
    correlate: "retrieval.city · retrieval.shown",
  },
  {
    code: "incorrect",
    de: "Inhaltlich falsch",
    en: "Factually wrong",
    correlate: "knowledge.version_digest",
  },
  {
    code: "unclear",
    de: "Unklar formuliert",
    en: "Unclear wording",
    correlate: "model · tokens.output",
  },
  {
    code: "unanswered",
    de: "Frage nicht beantwortet",
    en: "Question not answered",
    correlate: "tools.called = none",
  },
  {
    code: "tool_failed",
    de: "Hat technisch nicht geklappt",
    en: "Technical problem",
    correlate: "tools.errors · retrieval.searched",
  },
  {
    code: "misunderstood",
    de: "Falsch verstanden",
    en: "Misunderstood me",
    correlate: "retrieval.city · tools.called",
  },
  {
    code: "other",
    de: "Sonstiges",
    en: "Something else",
    correlate: "(read the comment)",
  },
] as const;

export type ReasonCode = (typeof REASONS)[number]["code"];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && REASONS.some((r) => r.code === value);
}

/**
 * The human reviewer's classification, set from inside the Langfuse annotation
 * queues as the `review-verdict` CATEGORICAL score. Exactly ONE verdict per
 * reviewed item. `promote` says what `feedback:promote` does with it.
 */
export const REVIEW_VERDICTS = [
  {
    value: "good-example",
    en: "Answer is a model response — promote to the golden-answers dataset",
    promote: "golden" as const,
  },
  {
    value: "incorrect",
    en: "Answer states something factually wrong",
    promote: "regression" as const,
  },
  {
    value: "partially-correct",
    en: "Answer is right in part but misses or muddles something",
    promote: "regression" as const,
  },
  {
    value: "unclear-question",
    en: "The visitor's question was too vague to answer well — not an agent defect",
    promote: "none" as const,
  },
  {
    value: "ux-issue",
    en: "Answer content fine; presentation, speed or widget flow caused the complaint",
    promote: "none" as const,
  },
  {
    value: "data-gap",
    en: "Our directory/KB lacks the information — fix the data, not the prompt",
    promote: "none" as const,
  },
  {
    value: "other",
    en: "Does not fit any category — leave a comment explaining",
    promote: "none" as const,
  },
] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]["value"];

/** Name of the reviewer score config in Langfuse. */
export const REVIEW_VERDICT_SCORE = "review-verdict";
