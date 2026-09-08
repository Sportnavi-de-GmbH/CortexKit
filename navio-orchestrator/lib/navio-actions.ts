/**
 * Action markers: how a specialist answer hands the visitor a real button, and how
 * it flags an answer as needing the data-freshness notice.
 *
 * Ported from kb-agent-langsmith-starter/lib/navio-actions.ts, adapted for the
 * orchestrator's SINGLE chat surface (docs/superpowers/specs/
 * 2026-09-08-chat-first-redesign.md).
 *
 * Neither specialist has a UI channel — their whole output is text. Both prompts
 * end an answer with a marker line — `[[action:contact]] [[action:meeting]]` — and
 * the partner prompt adds `[[notice:data]]` when it has named real studios. The
 * MASTER relays those answers verbatim (instructions.md rule R7 explicitly keeps
 * the marker line), so markers arrive here from BOTH specialists. This module
 * strips them out of the prose and reports what was asked for.
 *
 * Differences from the kb original, on purpose:
 *  - One surface, one guaranteed list (`GUARANTEED_ACTIONS`) — there is no
 *    faq/partner screen split any more, so `resolveActions` takes no surface.
 *  - `faq-agent` is NOT in the allowlist. The partner prompt emits it to mean
 *    "switch to the FAQ agent's screen"; in this widget the one chat already
 *    answers FAQ questions, so the chip would be a dead button. The marker is
 *    still stripped from the text (the regex matches ANY id).
 *
 * Everything here is pure so it can be unit-tested without a DOM; rendering and
 * navigation live in `components/navio/MessageActions.tsx` and `DataNotice.tsx`.
 */

/** The ids that produce a chip. Anything else parses to nothing (but is stripped). */
export const NAVIO_ACTION_IDS = [
  "partner",
  "studios",
  "contact",
  "meeting",
  "faq",
  "about",
] as const;

export type NavioActionId = (typeof NAVIO_ACTION_IDS)[number];

/** Non-button callouts an answer can carry. Currently one: the freshness warning. */
export const NAVIO_NOTICE_IDS = ["data"] as const;

export type NavioNoticeId = (typeof NAVIO_NOTICE_IDS)[number];

/**
 * Chips that appear under EVERY answer, whether a specialist remembered them or
 * not (owner requirement 2026-09-08): the visitor must ALWAYS be able to reach
 * the Sportnavi team (Kontaktformular + Termin buchen) and sportnavi.de/ueber-uns
 * from any answer. A prompt rule alone cannot deliver "always" — a model skips an
 * instruction now and then, the R7 relay can drop a marker line, and the miss is
 * invisible.
 */
export const GUARANTEED_ACTIONS: readonly NavioActionId[] = ["contact", "meeting", "about"];

/**
 * On an answer produced by a PARTNER SEARCH turn, the full studio search must
 * always be offered too (owner requirement 2026-09-08). The widget detects a
 * partner turn from the `find_partners` action.result event — not from markers,
 * which the relay can drop.
 */
export const PARTNER_GUARANTEED_ACTIONS: readonly NavioActionId[] = [
  "studios",
  "contact",
  "meeting",
  "about",
];

/**
 * A hallucinated or misspelled id must never reach the user as raw text, so the
 * patterns match ANY `[[action:…]]` / `[[notice:…]]` marker; the allowlists are
 * applied after.
 */
const MARKER = /\[\[(action|notice):([a-z0-9_-]+)\]\]/gi;

/**
 * A marker still being streamed — `[[`, `[[actio`, `[[action:cont` — at the very
 * end of the text. Without this the raw fragment flickers into the bubble for a
 * few hundred milliseconds while the model finishes the last line.
 */
const PARTIAL_MARKER = /\[\[[^\]\n]*$/;

/** Ceiling on the whole row — past four the chips wrap badly in a 380px panel. */
const MAX_ACTIONS = 4;

export interface ParsedMessage {
  /** The reply with every marker removed, ready for the markdown renderer. */
  text: string;
  /** Known action ids, in the order the agent emitted them, deduped. */
  actions: NavioActionId[];
  /** Known notice ids the agent attached to this answer. */
  notices: NavioNoticeId[];
}

function isKnownAction(id: string): id is NavioActionId {
  return (NAVIO_ACTION_IDS as readonly string[]).includes(id);
}

function isKnownNotice(id: string): id is NavioNoticeId {
  return (NAVIO_NOTICE_IDS as readonly string[]).includes(id);
}

/**
 * Split an assistant message into display text, action ids and notice ids.
 *
 * Safe to call on every render, including mid-stream: markers are removed
 * wherever they appear (the prompts say last line, but the master's allowed
 * trailing follow-up question can move them mid-message, and a model that
 * inlines one must not leak it), and a half-written marker at the end is
 * swallowed too.
 */
export function parseMessageActions(raw: string): ParsedMessage {
  const actions: NavioActionId[] = [];
  const notices: NavioNoticeId[] = [];

  let text = raw.replace(MARKER, (_match, kind: string, id: string) => {
    const normalized = id.toLowerCase();
    if (kind.toLowerCase() === "notice") {
      if (isKnownNotice(normalized) && !notices.includes(normalized)) notices.push(normalized);
    } else if (isKnownAction(normalized) && !actions.includes(normalized)) {
      actions.push(normalized);
    }
    return "";
  });

  text = text.replace(PARTIAL_MARKER, "");

  // Markers sit on their own trailing line, so removing them leaves the blank
  // line that separated them — trim the end, but keep leading text untouched.
  return { text: text.replace(/[ \t]+$/gm, "").trimEnd(), actions, notices };
}

/**
 * The chips actually shown: what the specialists asked for, plus the guaranteed
 * ones, capped at a row that still fits.
 *
 * Kept separate from parsing so each stays honest — `parseMessageActions` reports
 * what the agent said, this applies the display policy on top. The guaranteed chips
 * go LAST but are reserved space FIRST: the agent's own first marker is its most
 * relevant next step and should stay leftmost, while a chatty (or R6-combined)
 * answer must never be able to push a guaranteed chip off the end.
 *
 * `partner: true` (a turn that actually ran `find_partners`) swaps in the partner
 * guarantee, which fills the whole row: studios, contact, meeting, about.
 */
export function resolveActions(
  requested: readonly NavioActionId[],
  opts?: { partner?: boolean },
): NavioActionId[] {
  const guaranteed = opts?.partner ? PARTNER_GUARANTEED_ACTIONS : GUARANTEED_ACTIONS;

  const rest = requested.filter((id) => !guaranteed.includes(id));
  const room = Math.max(0, MAX_ACTIONS - guaranteed.length);

  return [...rest.slice(0, room), ...guaranteed];
}
