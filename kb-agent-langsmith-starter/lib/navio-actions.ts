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
 *
 * The FAQ prompt (v4) also cites knowledge-base sources with `[[source:URL]]`;
 * they come back as `sources` and render in `components/navio/SourceList.tsx`.
 */

import { KB_SOURCE_URLS } from "./kb-sources";

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

/**
 * Ids the parser still recognises — so their markers are stripped from the prose —
 * but the widget never shows: the Partner finder and the booking link were removed
 * from Navio. The prompts may still emit them, hence parse-but-hide rather than
 * dropping them from NAVIO_ACTION_IDS.
 */
export const HIDDEN_ACTION_IDS = ["partner", "meeting"] as const;

export type VisibleActionId = Exclude<NavioActionId, (typeof HIDDEN_ACTION_IDS)[number]>;

function isVisibleAction(id: NavioActionId): id is VisibleActionId {
  return !(HIDDEN_ACTION_IDS as readonly string[]).includes(id);
}

/** Non-button callouts an answer can carry. Currently one: the freshness warning. */
export const NAVIO_NOTICE_IDS = ["data"] as const;

export type NavioNoticeId = (typeof NAVIO_NOTICE_IDS)[number];

/** Which chat screen the message came from — the two have different guarantees. */
export type NavioSurface = "faq" | "partner";

/**
 * Chips that appear under EVERY answer on a screen, whether the agent remembered
 * them or not.
 *
 * These are product requirements — sportnavi.de/ueber-uns must always be one
 * click away, and the partner screen must always offer the full studio search — and
 * a prompt rule alone cannot deliver "always": a model skips an instruction now and
 * then, and the miss is invisible. So the prompts ask for them and this guarantees
 * them.
 *
 * The partner screen guarantees its WHOLE row, in a fixed order: the V3 workflow
 * agent that answers there emits no markers at all, and the row must read the
 * same under every answer as it does under a FAQ answer (hand-off to the FAQ
 * agent, studio search, contact, about).
 */
export const ALWAYS_ACTIONS: Record<NavioSurface, readonly VisibleActionId[]> = {
  faq: ["about"],
  partner: ["faq-agent", "studios", "contact", "about"],
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

/**
 * Ceiling on the whole row. Five, so the FAQ agent's usual four (partner,
 * contact, meeting, faq) all survive next to the guaranteed `about` — at four,
 * `faq` was silently dropped. The row wraps to a second line in the 380px panel;
 * that is by design (MessageActions uses flex-wrap).
 */
const MAX_ACTIONS = 5;

/**
 * `[[source:https://…]]` — a knowledge-base citation (FAQ prompt §7A). Matched
 * separately from MARKER because a URL is not an id; processed first so its
 * text never reaches MARKER or PARTIAL_MARKER.
 */
const SOURCE_MARKER = /\[\[source:\s*([^\]\s]+)\s*\]\]/gi;

/** A label line opening a sources block in the prose: "Quellen:", "**Quellen:**", "Sources:". */
const PROSE_SOURCES_LABEL = /^\s*(?:\*\*)?\s*(?:quellen|quelle|sources?)\s*:?\s*(?:\*\*)?\s*:?\s*(.*)$/i;

/** A markdown link or bare URL — the only things a sources line may contain. */
const LINK_TOKEN = /\[[^\]\n]*\]\(([^)\s]+)\)|<?(https?:\/\/[^\s>)\]]+)>?/g;

/** Most sources shown under one answer — the prompt asks for at most four. */
const MAX_SOURCES = 4;

/**
 * Comparison key for a URL: scheme, `www.`, case and trailing slash ignored, so
 * `https://sportnavi.de/kontakt` and `https://www.sportnavi.de/kontakt/` match.
 */
function sourceKey(url: string): string {
  return url
    .trim()
    .replace(/[.,;:]+$/, "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const KB_SOURCES_BY_KEY = new Map<string, string>();
for (const url of KB_SOURCE_URLS) {
  // First spelling wins, so the canonical (first-cited) form is what is shown.
  if (!KB_SOURCES_BY_KEY.has(sourceKey(url))) KB_SOURCES_BY_KEY.set(sourceKey(url), url);
}

/**
 * The KB's own spelling of a cited URL, or null when the knowledge base never
 * cites it. This is the guarantee behind "never invent sources": a URL the model
 * made up is simply not shown.
 */
export function resolveSource(url: string): string | null {
  return KB_SOURCES_BY_KEY.get(sourceKey(url)) ?? null;
}

/** Every URL in a line, or null if the line holds anything besides links. */
function linksOnly(line: string): string[] | null {
  const urls: string[] = [];
  const rest = line
    .replace(LINK_TOKEN, (_m, mdHref: string | undefined, bare: string | undefined) => {
      urls.push(mdHref ?? bare ?? "");
      return "";
    })
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/[\s,;|·]/g, "");
  return rest === "" ? urls : null;
}

/**
 * Lift a "Quellen:" block the model wrote into the prose out of it. The KB formats
 * every source that way, so a model that copies an entry reproduces it; the widget
 * shows sources in one place only, so the block is moved, never shown twice. Only
 * a label followed by nothing but links counts — "Quelle: deine Personalabteilung"
 * is ordinary text and stays.
 */
function extractProseSources(text: string): { text: string; urls: string[] } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const urls: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const label = PROSE_SOURCES_LABEL.exec(lines[i]!);
    const first = label ? linksOnly(label[1]!) : null;
    if (!label || first === null) {
      kept.push(lines[i]!);
      continue;
    }
    const block = [...first];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const more = lines[j]!.trim() === "" ? null : linksOnly(lines[j]!);
      if (more === null || more.length === 0) break;
      block.push(...more);
    }
    if (block.length === 0) {
      kept.push(lines[i]!);
      continue;
    }
    urls.push(...block);
    i = j - 1;
  }
  return { text: kept.join("\n"), urls };
}

export interface ParsedMessage {
  /** The reply with every marker removed, ready for the markdown renderer. */
  text: string;
  /** Known action ids, in the order the agent emitted them, deduped. */
  actions: NavioActionId[];
  /** Known notice ids the agent attached to this answer. */
  notices: NavioNoticeId[];
  /** Cited KB source URLs (KB spelling), in citation order, deduped, capped at MAX_SOURCES. */
  sources: string[];
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
  const cited: string[] = [];

  let text = raw.replace(SOURCE_MARKER, (_match, url: string) => {
    cited.push(url);
    return "";
  });

  const prose = extractProseSources(text);
  text = prose.text;
  cited.push(...prose.urls);

  const sources: string[] = [];
  for (const url of cited) {
    const known = resolveSource(url);
    if (known && !sources.includes(known) && sources.length < MAX_SOURCES) sources.push(known);
  }

  text = text.replace(MARKER, (_match, kind: string, id: string) => {
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
  return { text: text.replace(/[ \t]+$/gm, "").trimEnd(), actions, notices, sources };
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
): VisibleActionId[] {
  const guaranteed = ALWAYS_ACTIONS[surface];

  // Pull the guaranteed ids out of the request first, whether or not the agent
  // asked for them. Trimming the rest against `MAX_ACTIONS - guaranteed.length`
  // is then exact — the earlier version reserved room only for the ones the agent
  // had NOT asked for, so an answer that emitted them mid-list overflowed the row.
  // Hidden ids (removed features) are dropped before anything else.
  const rest = requested.filter(isVisibleAction).filter((id) => !guaranteed.includes(id));
  const room = Math.max(0, MAX_ACTIONS - guaranteed.length);

  return [...rest.slice(0, room), ...guaranteed];
}
