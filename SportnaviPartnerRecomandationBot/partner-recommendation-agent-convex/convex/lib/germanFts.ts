/**
 * convex/lib/germanFts.ts — the port of Postgres' German full-text search.
 *
 * WHAT IS BEING REPRODUCED
 *
 * `partners.fts` is a GENERATED tsvector column:
 *
 *   setweight(to_tsvector('german', coalesce(name,'')),                    'A')
 * || setweight(to_tsvector('german', coalesce(courses_text,'')),           'B')
 * || setweight(to_tsvector('german', coalesce(embedded_text, okf, '')),    'C')
 *
 * and match_partners' `kw` CTE ranks with
 *
 *   websearch_to_tsquery('german', query_text)  AND  ts_rank(fts, q)
 *
 * Three pieces are needed to behave the same: the same tokenizer, the same
 * German stopword list, and the same Snowball German stemmer. All three are
 * implemented below, so `to_tsvector('german','Yoga Entspannung Anfänger')`
 * and `germanLexemes(...)` produce the same lexemes: yoga, entspann, anfang.
 *
 * ── FIDELITY: what matches exactly, and what does not ────────────────────────
 *
 * EXACT:
 *  - Tokenization, the Snowball German stopword list, and the Snowball German
 *    stemmer (the `german` dictionary Postgres ships).
 *  - websearch_to_tsquery's AND semantics. This one matters more than it
 *    looks: CLAUDE.md §10.4 documents that ANDing is precisely why the FTS
 *    branch almost never fires for multi-word German intents. Reproducing the
 *    AND is what keeps the Convex build's retrieval behaviour comparable
 *    instead of accidentally better. Quoted phrases and the `or` / `-`
 *    operators websearch_to_tsquery understands are supported too.
 *
 * APPROXIMATED — `tsRank()`:
 *    Postgres' ts_rank uses lexeme POSITIONS to weight and saturate the score.
 *    A tsvector's positions are not something we can carry over usefully, so
 *    this scores each matched query term by the highest section weight it
 *    appears in, using ts_rank's own default weight vector {D,C,B,A} =
 *    {0.1, 0.2, 0.4, 1.0}, and applies ts_rank's saturation `w/(w+1)`.
 *
 *    Why the approximation is safe HERE: the `kw` CTE never exports its score
 *    as a result value. It exports `row_number() over (order by ts_rank desc)`
 *    into the RRF fusion. Only the ORDER of the ~40 keyword hits within one
 *    city survives, and section weight dominates that order. The absolute
 *    `fts_rank` value IS returned to the client, but no application code reads
 *    it (verified: lib/partners/similarity-search-partners.ts maps only
 *    `similarity`). This is documented in ../MIGRATION-NOTES.md.
 */

// ─── Stopwords ───────────────────────────────────────────────────────────────
// The Snowball German stopword list, which is what Postgres ships as
// $SHAREDIR/tsearch_data/german.stop and what the `german` text search
// configuration removes before stemming.
const GERMAN_STOPWORDS = new Set<string>(
  `aber alle allem allen aller alles als also am an ander andere anderem anderen
   anderer anderes anderm andern anderr anders auch auf aus bei bin bis bist da
   damit dann der den des dem die das dass daß derselbe derselben denselben
   desselben demselben dieselbe dieselben dasselbe dazu dein deine deinem deinen
   deiner deines denn derer dessen dich dir du dies diese diesem diesen dieser
   dieses doch dort durch ein eine einem einen einer eines einig einige einigem
   einigen einiger einiges einmal er ihn ihm es etwas euer eure eurem euren
   eurer eures für gegen gewesen hab habe haben hat hatte hatten hier hin hinter
   ich mich mir ihr ihre ihrem ihren ihrer ihres euch im in indem ins ist jede
   jedem jeden jeder jedes jene jenem jenen jener jenes jetzt kann kein keine
   keinem keinen keiner keines können könnte machen man manche manchem manchen
   mancher manches mein meine meinem meinen meiner meines mit muss musste nach
   nicht nichts noch nun nur ob oder ohne sehr sein seine seinem seinen seiner
   seines selbst sich sie ihnen sind so solche solchem solchen solcher solches
   soll sollte sondern sonst über um und uns unse unsem unsen unser unses unter
   viel vom von vor während war waren warst was weg weil weiter welche welchem
   welchen welcher welches wenn werde werden wie wieder will wir wird wirst wo
   wollen wollte würde würden zu zum zur zwar zwischen`
    .split(/\s+/)
    .filter(Boolean),
);

// ─── Tokenizer ───────────────────────────────────────────────────────────────
// Postgres' default parser emits `word`/`numword`/`asciiword` tokens; for this
// corpus that is equivalent to "runs of letters (incl. German umlauts) and
// digits", lowercased.
const TOKEN_RE = /[0-9a-zà-öø-ÿœ]+/gi;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []) as string[];
}

// ─── Snowball German stemmer ─────────────────────────────────────────────────
// Faithful implementation of the "german" (Snowball v1) algorithm — the one
// Postgres' `german_stem` dictionary uses.

const VOWELS = new Set(["a", "e", "i", "o", "u", "y", "ä", "ö", "ü"]);
const S_ENDING = new Set(["b", "d", "f", "g", "h", "k", "l", "m", "n", "r", "t"]);
const ST_ENDING = new Set(["b", "d", "f", "g", "h", "k", "l", "m", "n", "t"]);

const isVowel = (c: string | undefined) => c !== undefined && VOWELS.has(c);

/**
 * Prelude: ß -> ss, and u/y BETWEEN two vowels are upper-cased so the suffix
 * rules below stop treating them as vowels.
 */
function prelude(word: string): string {
  let w = word.replace(/ß/g, "ss");
  const chars = [...w];
  for (let i = 1; i < chars.length - 1; i++) {
    const c = chars[i]!;
    if ((c === "u" || c === "y") && isVowel(chars[i - 1]) && isVowel(chars[i + 1])) {
      chars[i] = c.toUpperCase();
    }
  }
  return chars.join("");
}

/** The position after the first non-vowel following a vowel, at or after `start`. */
function markRegion(word: string, start: number): number {
  for (let j = start + 1; j < word.length; j++) {
    if (!isVowel(word[j]) && isVowel(word[j - 1])) return j + 1;
  }
  return word.length;
}

/** R1/R2 as defined by Snowball. R2 is measured from the UNADJUSTED R1, then
 *  German's "R1 must be at least 3" rule is applied — the order german.sbl
 *  uses (`setmark p1; try($p1 < x $p1 = x); … setmark p2` scans from the raw
 *  cursor position, not the clamped one). */
function regions(word: string): { r1: number; r2: number } {
  const rawR1 = markRegion(word, 0);
  const r2 = markRegion(word, rawR1);
  const r1 = rawR1 < 3 ? Math.min(3, word.length) : rawR1;
  return { r1, r2 };
}

/** Longest matching suffix from `suffixes`, or undefined. */
function longestSuffix(word: string, suffixes: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const s of suffixes) {
    if (word.endsWith(s) && (best === undefined || s.length > best.length)) best = s;
  }
  return best;
}

const STEP1_A = ["em", "ern", "er"] as const;
const STEP1_B = ["e", "en", "es"] as const;
const STEP2_A = ["en", "er", "est"] as const;

export function germanStem(input: string): string {
  if (input.length <= 2) return input;

  let word = prelude(input);
  const { r1, r2 } = regions(word);
  const inR1 = (suffixLen: number) => word.length - suffixLen >= r1;
  const inR2 = (suffixLen: number) => word.length - suffixLen >= r2;

  // ── Step 1 ────────────────────────────────────────────────────────────────
  const a1 = longestSuffix(word, STEP1_A);
  const b1 = longestSuffix(word, STEP1_B);
  // (c) a lone `s` preceded by a valid s-ending
  const c1 =
    word.endsWith("s") && S_ENDING.has(word[word.length - 2] ?? "") ? "s" : undefined;

  const step1 = [a1, b1, c1]
    .filter((s): s is string => s !== undefined)
    .sort((x, y) => y.length - x.length)[0];

  if (step1 !== undefined && inR1(step1.length)) {
    word = word.slice(0, word.length - step1.length);
    // "if an ending of group (b) is deleted, and the ending is preceded by
    //  niss, delete the final s"
    if ((STEP1_B as readonly string[]).includes(step1) && word.endsWith("niss")) {
      word = word.slice(0, -1);
    }
  }

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const a2 = longestSuffix(word, STEP2_A);
  const b2 =
    word.endsWith("st") &&
    ST_ENDING.has(word[word.length - 3] ?? "") &&
    word.length >= 6 // the st-ending must be preceded by at least 3 letters
      ? "st"
      : undefined;

  const step2 = [a2, b2]
    .filter((s): s is string => s !== undefined)
    .sort((x, y) => y.length - x.length)[0];

  if (step2 !== undefined && word.length - step2.length >= r1) {
    word = word.slice(0, word.length - step2.length);
  }

  // ── Step 3 (d-suffixes) ───────────────────────────────────────────────────
  const d = longestSuffix(word, ["end", "ung", "ig", "ik", "isch", "lich", "heit", "keit"]);
  if (d !== undefined) {
    const stem = word.slice(0, word.length - d.length);
    switch (d) {
      case "end":
      case "ung":
        if (inR2(d.length)) {
          if (stem.endsWith("ig") && !stem.endsWith("eig") && stem.length - 2 >= r2) {
            word = stem.slice(0, -2);
          } else {
            word = stem;
          }
        }
        break;
      case "ig":
      case "ik":
      case "isch":
        if (inR2(d.length) && !stem.endsWith("e")) word = stem;
        break;
      case "lich":
      case "heit":
        if (inR2(d.length)) {
          if (
            (stem.endsWith("er") || stem.endsWith("en")) &&
            stem.length - 2 >= r1
          ) {
            word = stem.slice(0, -2);
          } else {
            word = stem;
          }
        }
        break;
      case "keit":
        if (inR2(d.length)) {
          if (stem.endsWith("lich") && stem.length - 4 >= r2) word = stem.slice(0, -4);
          else if (stem.endsWith("ig") && stem.length - 2 >= r2) word = stem.slice(0, -2);
          else word = stem;
        }
        break;
    }
  }

  // ── Postlude: restore case, strip umlaut accents ──────────────────────────
  return word
    .replace(/U/g, "u")
    .replace(/Y/g, "y")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u");
}

// ─── to_tsvector('german', …) ────────────────────────────────────────────────

/**
 * The lexeme set of a text: tokenize -> drop stopwords -> stem -> dedupe.
 * Equivalent to the DISTINCT lexemes of `to_tsvector('german', text)`.
 *
 * Called at SEED time (once per partner, per weight section) and stored in
 * `partnerSearchDocs.lexA/lexB/lexC` — the direct analogue of Postgres storing
 * a GENERATED tsvector column instead of re-parsing text on every query.
 */
export function germanLexemes(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const token of tokenize(text)) {
    if (GERMAN_STOPWORDS.has(token)) continue;
    const stem = germanStem(token);
    if (stem.length > 0) out.add(stem);
  }
  return [...out];
}

// ─── websearch_to_tsquery('german', …) ───────────────────────────────────────

export interface TsQuery {
  /** Every group must match (AND). A group with >1 lexeme is a quoted phrase,
   *  which we relax to "all of these lexemes present" — positions are not
   *  stored, so phrase adjacency cannot be checked. Documented deviation. */
  and: string[][];
  /** At least one alternative group must match, if any are present (OR). */
  or: string[][];
  /** None of these may match (the `-term` operator). */
  not: string[];
}

/**
 * Port of `websearch_to_tsquery('german', text)`.
 *
 * websearch syntax: unquoted words are ANDed, "quoted phrases" become <->
 * phrase operators, the bare word `or` becomes |, and a leading `-` negates.
 * THE AND IS THE IMPORTANT PART — see the file header.
 */
export function websearchToTsQuery(text: string | null | undefined): TsQuery | null {
  if (!text || text.trim() === "") return null;

  const and: string[][] = [];
  const or: string[][] = [];
  const not: string[] = [];

  // Split into quoted phrases and bare runs, preserving order.
  const parts = text.match(/"[^"]*"|\S+/g) ?? [];
  let pendingOr = false;

  for (const raw of parts) {
    if (raw.toLowerCase() === "or") {
      pendingOr = true;
      continue;
    }
    const negated = raw.startsWith("-");
    const body = negated ? raw.slice(1) : raw;
    const phrase = body.startsWith('"') && body.endsWith('"');
    const lexemes = germanLexemes(phrase ? body.slice(1, -1) : body);
    if (lexemes.length === 0) {
      pendingOr = false;
      continue;
    }
    if (negated) {
      not.push(...lexemes);
    } else if (pendingOr) {
      // `a or b` — move the previous AND group into the OR alternatives too.
      const prev = and.pop();
      if (prev) or.push(prev);
      or.push(lexemes);
    } else {
      and.push(lexemes);
    }
    pendingOr = false;
  }

  if (and.length === 0 && or.length === 0 && not.length === 0) return null;
  return { and, or, not };
}

// ─── @@ and ts_rank ──────────────────────────────────────────────────────────

/** ts_rank's default weight vector {D, C, B, A}. */
const WEIGHTS = { A: 1.0, B: 0.4, C: 0.2, D: 0.1 } as const;

export interface WeightedLexemes {
  lexA: readonly string[];
  lexB: readonly string[];
  lexC: readonly string[];
}

/**
 * A tsvector, as `lexeme -> highest section weight`. Built ONCE per candidate
 * document and reused across the @@ test and ts_rank, rather than doing a
 * linear scan of three arrays per query lexeme.
 */
export type TsVector = Map<string, number>;

export function toTsVector(doc: WeightedLexemes): TsVector {
  const v: TsVector = new Map();
  // Lowest weight first, so a lexeme present in several sections keeps the
  // highest — same as Postgres' setweight() concatenation semantics.
  for (const l of doc.lexC) v.set(l, WEIGHTS.C);
  for (const l of doc.lexB) v.set(l, WEIGHTS.B);
  for (const l of doc.lexA) v.set(l, WEIGHTS.A);
  return v;
}

/** The `fts @@ q` operator. */
export function matchesTsQuery(vec: TsVector, q: TsQuery): boolean {
  for (const l of q.not) if (vec.has(l)) return false;
  for (const group of q.and) {
    if (!group.every((l) => vec.has(l))) return false;
  }
  if (q.or.length > 0 && !q.or.some((g) => g.every((l) => vec.has(l)))) return false;
  return true;
}

/**
 * Approximation of `ts_rank(fts, q)` — see the fidelity note in the file
 * header. Sums the best section weight per matched query lexeme and applies
 * ts_rank's saturation, so the value lands in (0, 1) like the real thing and,
 * critically, orders hits the same way section weights do.
 */
export function tsRank(vec: TsVector, q: TsQuery): number {
  const lexemes = new Set<string>([...q.and.flat(), ...q.or.flat()]);
  let sum = 0;
  for (const l of lexemes) sum += vec.get(l) ?? 0;
  return sum === 0 ? 0 : sum / (sum + 1); // ts_rank's word-saturation shape
}
