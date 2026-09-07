/**
 * lib/partners/grounding-check.ts
 *
 * A LIVE, ALERT-ONLY tripwire for the product's core invariant ("never
 * invent a partner" — CLAUDE.md §1, §12.1). eve's hooks are observe-only
 * (confirmed against node_modules/eve/dist/src/public/definitions/hook.d.ts
 * and both existing hook files' own comments) — a `message.completed`
 * handler cannot edit or withhold the outgoing reply. This module is
 * therefore NOT a guardrail that prevents fabrication; it is a detector
 * that turns a fabrication into a Sentry event *during* the request
 * instead of only during an offline `evals/` run. See
 * agent/hooks/budget.ts for the wiring and lib/sentry-agent.ts for the
 * `possible_fabrication` classification this feeds.
 *
 * Heuristic, not NLP: extract Title-Case multi-word spans (the shape a
 * German business name takes in prose — "Yoga Studio Nord",
 * "Fitness Point Bochum") and flag any span that doesn't case-insensitively
 * substring-match a partner name this turn's `find_partners` actually
 * returned. False positives (a real proper noun that happens to not be a
 * partner name — a street, a district) are expected and acceptable for an
 * alert-only signal. False negatives (a fabrication that doesn't look
 * Title-Case, or that reuses part of a real name) are the failure mode to
 * minimize, so this leans permissive rather than trying to be precise.
 */

/** Common German conversational openers/closers that are Title-Case but never
 *  partner names — kept short and deliberately conservative; better to flag
 *  a false positive than to grow this into a place fabrications hide. */
const STOPWORD_SPANS = new Set(
  [
    "Hallo Zusammen",
    "Viel Erfolg",
    "Viel Spaß",
    "Gutes Training",
    "Alles Gute",
    "Bis Bald",
    "Liebe Grüße",
  ].map((s) => s.toLowerCase()),
);

/** Two-or-more consecutive capitalized words, allowing German umlauts. */
const TITLE_CASE_SPAN = /(?:[A-ZÄÖÜ][\p{L}'-]*\s+){1,5}[A-ZÄÖÜ][\p{L}'-]*/gu;

export interface GroundingCheckResult {
  flagged: boolean;
  suspectNames: string[];
}

/**
 * @param replyText The assistant's final German prose reply for this turn.
 * @param knownNames Partner names this turn's `find_partners` call actually
 *   returned (see `lib/request-budget.ts`'s `recordKnownNames`). Matching is
 *   case-insensitive substring in both directions so a shortened or
 *   article-prefixed mention ("das Yoga Studio Nord") still matches.
 */
export function checkGrounding(replyText: string, knownNames: string[]): GroundingCheckResult {
  const knownLower = knownNames.map((n) => n.toLowerCase()).filter((n) => n.length > 0);
  // Nothing to ground against — either no search ran this turn (a greeting,
  // a clarifying question) or it returned no partners. Flagging Title-Case
  // spans in that case would just be city names and pleasantries, not
  // fabrication candidates, so skip the check entirely rather than firing a
  // false-positive storm on every non-search turn.
  if (knownLower.length === 0) return { flagged: false, suspectNames: [] };
  const spans = replyText.match(TITLE_CASE_SPAN) ?? [];

  const suspectNames: string[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const lower = span.toLowerCase();
    if (STOPWORD_SPANS.has(lower)) continue;
    if (seen.has(lower)) continue;
    const matchesKnown = knownLower.some((name) => name.includes(lower) || lower.includes(name));
    if (!matchesKnown) {
      seen.add(lower);
      suspectNames.push(span);
    }
  }

  return { flagged: suspectNames.length > 0, suspectNames };
}
