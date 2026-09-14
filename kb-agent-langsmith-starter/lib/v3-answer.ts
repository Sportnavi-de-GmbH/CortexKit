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

const ITEM_RE = /^\*\*(\d+)\.\s+(.+?)\*\*\s*(.*)$/;
const BOLD_LINE_RE = /^\*\*(.+?)\*\*\s*$/;
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
  if (!paras.some((p) => p.some((l) => ITEM_RE.test(l)))) return null;

  const byLabel = new Map(tasks.map((t) => [t.label, t]));
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
    const first = para[0]!;
    const bold = BOLD_LINE_RE.exec(first);
    if (para.length === 1 && bold && byLabel.has(bold[1]!)) {
      push(current);
      task = byLabel.get(bold[1]!)!;
      current = { label: task.label, intro: "", items: [] };
      continue;
    }
    // A task heading directly followed by the intro line in the same paragraph.
    if (bold && byLabel.has(bold[1]!) && para.length > 1) {
      push(current);
      task = byLabel.get(bold[1]!)!;
      current = { label: task.label, intro: "", items: [] };
      para.shift();
    }
    // Within one paragraph, several items may appear back-to-back (no blank line).
    let itemLines: string[] | null = null;
    const proseLines: string[] = [];
    const flushItem = () => {
      if (!itemLines) return;
      const m = ITEM_RE.exec(itemLines[0]!)!;
      const rank = Number(m[1]);
      const recommendation = task?.recommendations.find((r) => r.rank === rank) ?? null;
      const lines = [m[3]!.trim(), ...itemLines.slice(1)].filter(Boolean);
      // The prompt asks the model to mention contact details in prose; with a
      // card, the same phone/e-mail/website are action chips right below, so
      // the "Kontakt: …" line would be printed twice. Text-only items keep it.
      const reason = (recommendation ? lines.filter((l) => !CONTACT_LINE_RE.test(l)) : lines).join("\n");
      current.items.push({ rank, heading: m[2]!.trim(), reason, recommendation });
      itemLines = null;
    };
    for (const line of para) {
      if (ITEM_RE.test(line)) {
        flushItem();
        itemLines = [line];
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
