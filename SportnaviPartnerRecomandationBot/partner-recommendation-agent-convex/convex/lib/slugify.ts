/**
 * convex/lib/slugify.ts — a 1:1 port of the Postgres function `slugify_tag`.
 *
 *   select trim(both '-' from
 *            regexp_replace(
 *              replace(replace(replace(replace(lower(t),
 *                'ä','ae'),'ö','oe'),'ü','ue'),'ß','ss'),
 *              '[^a-z0-9]+', '-', 'g'))
 *
 * Used for city grouping (city_centroids), fuzzy city resolution
 * (resolve_city_fuzzy) and tag normalization (match_partners' qraw CTE), so it
 * must behave identically to the SQL or the two backends disagree about which
 * city a request resolved to.
 *
 * Pure, dependency-free, and imported by BOTH the Convex functions and the
 * Node-side seed scripts — one definition, no drift.
 */
export function slugifyTag(t: string | null | undefined): string {
  if (t === null || t === undefined) return ""; // SQL fn is STRICT: null in, null out
  return t
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
