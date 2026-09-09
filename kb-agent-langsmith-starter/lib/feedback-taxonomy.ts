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
 * reviewed item, and each verdict maps to exactly one action (`promote` says
 * what `feedback:promote` does with it; the rest is a human to-do).
 *
 * Reduced from seven values to four on 2026-09-09: a reviewer should decide
 * "is the answer good, wrong, data-limited, or not the agent's fault?" and
 * move on — finer distinctions (partially-correct vs incorrect, unclear
 * question vs UX complaint) never changed the follow-up action.
 */
export const REVIEW_VERDICTS = [
  {
    value: "good-example",
    en: "A model answer — promote to the golden-answers dataset",
    promote: "golden" as const,
  },
  {
    value: "wrong-answer",
    en: "Wrong or misleading in any part — promote to the regression dataset",
    promote: "regression" as const,
  },
  {
    value: "data-gap",
    en: "The answer is fine but our directory/KB lacks the information — fix the data, not the prompt",
    promote: "none" as const,
  },
  {
    value: "not-a-defect",
    en: "Vague question, UX/speed complaint, or nothing to change",
    promote: "none" as const,
  },
] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]["value"];

/** Name of the reviewer score config in Langfuse. */
export const REVIEW_VERDICT_SCORE = "review-verdict";
