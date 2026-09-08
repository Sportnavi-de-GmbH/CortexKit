/**
 * Action markers: how an agent hands the user a real button, and how it flags an
 * answer as needing the data-freshness notice.
 *
 * Neither agent has a UI channel — the FAQ agent has no tools at all, and the
 * partner agent's two tools only fetch data (CLAUDE.md §5). Their whole output is
 * text. So both prompts end an answer with a marker line —
 * `[[action:contact]] [[action:meeting]] [[action:faq]]` — and the partner prompt
 * adds `[[notice:data]]` when it has named real studios. This module strips all of
 * that out of the prose and reports what was asked for.
 *
 * Everything here is pure so it can be unit-tested without a DOM; rendering and
 * navigation live in `components/navio/MessageActions.tsx` and `DataNotice.tsx`.
 */

/** The ids a prompt is allowed to emit. Anything else is dropped. */
export const NAVIO_ACTION_IDS = [
  "partner",
  "faq-agent",
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

/** Which chat screen the message came from — the two have different guarantees. */
export type NavioSurface = "faq" | "partner";

/**
 * Chips that appear under EVERY answer on a screen, whether the agent remembered
 * them or not.
 *
 * Both entries are product requirements — sportnavi.de/ueber-uns must always be one
 * click away, and the partner screen must always offer the full studio search — and
 * a prompt rule alone cannot deliver "always": a model skips an instruction now and
 * then, and the miss is invisible. So the prompts ask for them and this guarantees
 * them.
 */
export const ALWAYS_ACTIONS: Record<NavioSurface, readonly NavioActionId[]> = {
  faq: ["about"],
  partner: ["studios", "about"],
};

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
 * wherever they appear (the prompts say last line, but a model that inlines one
 * must not leak it), and a half-written marker at the end is swallowed too.
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
 * The chips actually shown: what the agent asked for, plus the screen's guaranteed
 * ones, capped at a row that still fits.
 *
 * Kept separate from parsing so each stays honest — `parseMessageActions` reports
 * what the agent said, this applies the display policy on top. The guaranteed chips
 * go LAST but are reserved space FIRST: the agent's own first marker is its most
 * relevant next step (the FAQ hand-off, say) and should stay leftmost, while a
 * chatty answer must never be able to push a guaranteed chip off the end.
 */
export function resolveActions(
  requested: readonly NavioActionId[],
  surface: NavioSurface,
): NavioActionId[] {
  const guaranteed = ALWAYS_ACTIONS[surface];

  // Pull the guaranteed ids out of the request first, whether or not the agent
  // asked for them. Trimming the rest against `MAX_ACTIONS - guaranteed.length`
  // is then exact — the earlier version reserved room only for the ones the agent
  // had NOT asked for, so an answer that emitted them mid-list overflowed the row.
  const rest = requested.filter((id) => !guaranteed.includes(id));
  const room = Math.max(0, MAX_ACTIONS - guaranteed.length);

  return [...rest.slice(0, room), ...guaranteed];
}
