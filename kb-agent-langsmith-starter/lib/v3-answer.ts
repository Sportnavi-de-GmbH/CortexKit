/**
 * Partner cards for the V3 workflow agent — pairing its prose with its data.
 *
 * V3 answers in a FIXED shape (its answer prompt dictates it): optionally a
 * bold task heading per search (`**Tennis in Dortmund**`), a bold intro line,
 * then one bold numbered heading per partner (`**1. Name — Ort**`) followed by
 * the model's 1–2 "why" sentences, items separated by blank lines. Alongside
 * the text, every executed task carries `recommendations[]` — the structured,
 * DB-sourced partner facts (never model output). This module lines the two up
 * by task label and rank, so the widget can render each partner's sentence
 * INSIDE its card.
 *
 * Contract:
 *  1. Parsing never invents: an item without a matching recommendation keeps
 *     its text and simply gets no card; text outside any item stays text.
 *  2. Anything that does not look like the V3 shape yields `null`, and the
 *     caller renders plain markdown exactly as before cards existed.
 *  3. Pure — no DOM, so it is unit-tested against a real answer.
 */

export interface V3Card {
  logoUrl: string | null;
  street: string | null;
  postalCode: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  mapsUrl: string | null;
  tags: string[];
  courses: string[];
}

export interface V3Recommendation {
  rank: number;
  id: number;
  name: string;
  city: string;
  role: "target" | "nearby";
  distanceKm: number;
  card: V3Card;
}

export interface V3Task {
  label: string;
  recommendations: V3Recommendation[];
}

export interface V3Item {
  rank: number;
  /** The heading text without the number, e.g. "Sportbox - Dortmund — Dortmund". */
  heading: string;
  /** The model's sentences for this partner (markdown), possibly empty. */
  reason: string;
  recommendation: V3Recommendation | null;
}

export interface V3Section {
  /** The task label, or null for a single-task answer / trailing prose. */
  label: string | null;
  /** Markdown before the first item (the intro), or the whole text of a prose-only section. */
  intro: string;
  items: V3Item[];
}

export const V3_RESULT_KIND = "v3-tasks";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `metadata.result` envelope the workflow adapter attaches to an assistant message. */
export function readV3Result(result: unknown): V3Task[] | null {
  if (!isRec(result) || result.kind !== V3_RESULT_KIND || !Array.isArray(result.tasks)) return null;
  const tasks: V3Task[] = [];
  for (const t of result.tasks) {
    if (!isRec(t) || typeof t.label !== "string" || !Array.isArray(t.recommendations)) continue;
    tasks.push({ label: t.label, recommendations: t.recommendations.filter(isValidRecommendation) });
  }
  return tasks;
}

function isValidRecommendation(v: unknown): v is V3Recommendation {
  return isRec(v) && typeof v.rank === "number" && typeof v.name === "string" && isRec(v.card);
}

/**
 * A task heading line, normalised for lookup: `**Yoga in Berlin**`,
 * `### Yoga in Berlin`, `**Yoga in Berlin:**` or an all-caps `YOGA IN BERLIN`
 * all resolve to the label "yoga in berlin". Null for anything else.
 */
function headingKey(line: string): string | null {
  const m = /^(?:#{1,6}\s+)?\**\s*([^*]+?)\s*:?\s*\**\s*:?\s*$/.exec(line);
  if (!m) return null;
  const inner = m[1]!.trim();
  return inner ? inner.toLowerCase() : null;
}

interface ItemLine { rank: number; heading: string; rest: string }

/**
 * The prescribed form is `**1. Name — Ort**`, but the model (temperature 0.3)
 * also writes `1. **Name — Ort**`, `**1.** **Name — Ort**`, `1) …` and, rarely,
 * the plain `1. Name — Ort`. Observed live: one task in the prescribed form and
 * the next as a markdown list, which made a whole section fall back to prose.
 * All variants map to the same (rank, heading, rest-of-line).
 */
const ITEM_PATTERNS: RegExp[] = [
  /^\*\*(\d+)[.)]\s+(.+?)\*\*\s*(.*)$/, //  **1. Name — Ort** rest
  /^(?:\*\*(\d+)[.)]\*\*|(\d+)[.)])\s+\*\*(.+?)\*\*\s*(.*)$/, //  1. **Name — Ort** rest  ·  **1.** **Name — Ort** rest
];
// Plain `1. Name — Ort` (no bold at all) is accepted only with the name — place
// dash, so an ordinary numbered list in prose ("1. Bring Sportkleidung mit.")
// is never mistaken for a partner.
const PLAIN_ITEM_RE = /^(\d+)[.)]\s+(.+?\s[—–]\s.+?)\s*$/;

function parseItemLine(line: string): ItemLine | null {
  for (const re of ITEM_PATTERNS) {
    const m = re.exec(line);
    if (!m) continue;
    const groups = m.slice(1).filter((g): g is string => g !== undefined);
    // groups: [rank, heading, rest] — the alternation leaves one undefined rank slot
    return { rank: Number(groups[0]), heading: groups[1]!.trim(), rest: (groups[2] ?? "").trim() };
  }
  const plain = PLAIN_ITEM_RE.exec(line);
  return plain ? { rank: Number(plain[1]), heading: plain[2]!.trim(), rest: "" } : null;
}
const CONTACT_LINE_RE = /^\**_*\s*Kontakt\s*:/i;

/** Paragraphs (blank-line separated), each as its trimmed lines. */
function paragraphs(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Sections in answer order. `null` when there is not a single numbered item —
 * the "nothing found", clarification-only and error texts are plain prose.
 */
export function parseV3Answer(text: string, tasks: V3Task[]): V3Section[] | null {
  const paras = paragraphs(text);
  if (!paras.some((p) => p.some((l) => parseItemLine(l) !== null))) return null;

  const byLabel = new Map(tasks.map((t) => [t.label.trim().toLowerCase(), t]));
  const sections: V3Section[] = [];
  let current: V3Section = { label: null, intro: "", items: [] };
  // Single-task answers have no task heading, so their items belong to the one task.
  let task: V3Task | null = tasks.length === 1 ? (tasks[0] ?? null) : null;

  const push = (s: V3Section) => {
    if (s.label !== null || s.intro || s.items.length) sections.push(s);
  };
  const addProse = (chunk: string) => {
    if (current.items.length === 0) {
      current.intro = current.intro ? `${current.intro}\n\n${chunk}` : chunk;
    } else {
      // Prose after the items (clarification question, deferred note) is not
      // part of the last partner: it becomes its own unlabelled section.
      push(current);
      current = { label: null, intro: chunk, items: [] };
    }
  };

  for (const para of paras) {
    const key = headingKey(para[0]!);
    const headed = key !== null && !parseItemLine(para[0]!) ? byLabel.get(key) : undefined;
    if (headed) {
      push(current);
      task = headed;
      current = { label: task.label, intro: "", items: [] };
      // The heading may sit alone or be followed by the intro in the same paragraph.
      para.shift();
      if (para.length === 0) continue;
    }
    // Within one paragraph, several items may appear back-to-back (no blank line).
    let itemLines: string[] | null = null;
    let itemHead: ItemLine | null = null;
    const proseLines: string[] = [];
    const flushItem = () => {
      if (!itemLines || !itemHead) return;
      const { rank, heading, rest } = itemHead;
      const recommendation = task?.recommendations.find((r) => r.rank === rank) ?? null;
      const lines = [rest, ...itemLines.slice(1)].filter(Boolean);
      // The prompt asks the model to mention contact details in prose; with a
      // card, the same phone/e-mail/website are action chips right below, so
      // the "Kontakt: …" line would be printed twice. Text-only items keep it.
      const reason = (recommendation ? lines.filter((l) => !CONTACT_LINE_RE.test(l)) : lines).join("\n");
      current.items.push({ rank, heading, reason, recommendation });
      itemLines = null;
      itemHead = null;
    };
    for (const line of para) {
      const head = parseItemLine(line);
      if (head) {
        flushItem();
        itemLines = [line];
        itemHead = head;
      } else if (itemLines) itemLines.push(line);
      else proseLines.push(line);
    }
    if (proseLines.length) addProse(proseLines.join("\n"));
    flushItem();
  }
  push(current);
  return sections;
}

// ── Card display helpers (pure, so the component stays a thin renderer) ──

/**
 * Category chips: the directory's tags are its categories ("physiotherapie",
 * "ladies-kickboxing" — lower-case slugs), so they come first, title-cased;
 * the course list ("15 Minuten klassische Massage | …") only fills in when a
 * partner has no tags. Dedupe case-insensitively, cap at MAX_CATEGORY_CHIPS.
 */
const MAX_CATEGORY_CHIPS = 3;

export function pickCategories(tags: string[], courses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const pretty = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  for (const raw of [...tags.map(pretty), ...courses]) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label.length > 28 ? `${label.slice(0, 27)}…` : label);
    if (out.length === MAX_CATEGORY_CHIPS) break;
  }
  return out;
}

/** Street already carries "PLZ Ort" in this directory; don't repeat them. */
export function formatAddress(street: string | null, postalCode: string | null, rec: V3Recommendation | null): string | null {
  if (!street) return null;
  const tail = [postalCode, rec?.city].filter(Boolean).join(" ");
  if (!tail || street.includes(tail) || (postalCode && street.includes(postalCode))) return street;
  return `${street}, ${tail}`;
}
