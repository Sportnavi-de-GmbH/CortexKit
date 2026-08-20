/**
 * convex/lib/trigram.ts — a port of the `pg_trgm` extension's `similarity()`.
 *
 * Two call sites depend on it, and both are load-bearing:
 *  - resolve_city_fuzzy: `similarity(slugify_tag(city), slugify_tag(place)) > 0.4`
 *    decides whether a user's messy spelling resolves to a covered city at all.
 *  - match_partners' `nm` CTE: `similarity(name, query_text) > 0.25` is one of
 *    the four RRF ranking branches.
 *
 * ALGORITHM (from pg_trgm's trgm_op.c / generate_trgm):
 *  1. Lowercase the input.
 *  2. Split into words on any non-alphanumeric character.
 *  3. Pad each word with TWO leading blanks and ONE trailing blank, then take
 *     every 3-character window: "cat" -> ["  c", " ca", "cat", "at "].
 *  4. similarity = |A ∩ B| / |A ∪ B| over the DISTINCT trigram sets.
 *
 * Words shorter than 3 characters still yield trigrams thanks to the padding,
 * which is why "Ulm" resolves at all.
 */

/** Split into alphanumeric words exactly as pg_trgm's word boundary rule does. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 0);
}

/** The distinct trigram set of a string, with pg_trgm's blank padding. */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of words(text)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      out.add(padded.slice(i, i + 3));
    }
  }
  return out;
}

/**
 * pg_trgm `similarity(a, b)`: the Jaccard index of the two trigram sets.
 * Returns 0 when either side has no trigrams (pg_trgm returns 0, not NULL).
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  // Iterate the smaller set — the city table is scanned ~648 times per resolve.
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const g of small) if (large.has(g)) intersection++;

  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
