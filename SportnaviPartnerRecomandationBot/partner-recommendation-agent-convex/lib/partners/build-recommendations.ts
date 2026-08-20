/**
 * lib/partners/build-recommendations.ts
 *
 * Turn a ResolvedPartnerSet (Steps 2-5 of resolve-partners.ts) into the final
 * N recommendations the user sees (Step 6 of the pseudocode). Never
 * fabricates partners: returns min(finalRecommendations, available) (E11).
 * Hydrates display fields (the pre-rendered `llm_profile` block) via ONE
 * batched `get_partner_profiles` RPC call. No PII beyond the owner-approved
 * exception: contact info may appear INSIDE llmProfile, never as separate
 * email/phone fields.
 *
 * CONVEX PORT of the Supabase build's file of the same name. Only
 * `defaultGetPartnerProfiles` changed: the `get_partner_profiles` Postgres RPC
 * became `partners:getPartnerProfiles` (convex/partners.ts) with the identical
 * column list. Ranking, the shortlist cut, the short-hydration warning, the
 * empty-profile drop and the disclosure are business logic shared with the
 * Supabase build — the comparison depends on it staying so.
 */

import { getConvex, type ConvexBackend } from "../convex";
import type { PartnerLite, ResolvedPartnerSet } from "./types";
import { DEFAULT_CONFIG } from "../../agent/config/partner-injection.config";

export interface Recommendation {
  partnerId: number;
  name: string;
  city: string | null;
  source: "home" | "nearby";
  sourceCity: string;
  distanceKm?: number;
  similarity?: number;
  /** Pre-rendered, fully labeled profile block from partners.llm_profile. */
  llmProfile: string;
}

export interface BuildRecommendationsInput {
  set: ResolvedPartnerSet;
  /** Hard presentation cap for this search (shortlistMax semantics — R13 §4.5). */
  finalRecommendations: number;
  /**
   * Additional cap from the per-turn render-budget allocator (R13 §3.3):
   * the most full Tier-2 profiles this search's context allotment affords.
   * Omitted = uncapped by budget (single-search turns with room to spare).
   */
  maxShown?: number;
  /** Floor for the presented shortlist; defaults to DEFAULT_CONFIG.shortlistMin. */
  shortlistMin?: number;
  /**
   * Mirrors PartnerInjectionConfig.includeContactInShortlist. Defaults to
   * DEFAULT_CONFIG's value (true) when omitted. Carried through to the
   * output (below) purely so the model-facing renderer can read it — see
   * that field's doc comment.
   */
  includeContactInShortlist?: boolean;
}

export interface BuildRecommendationsOutput {
  recommendations: Recommendation[];
  disclosure: string;
  warnings: string[];
  /**
   * Canonical requested city, carried through so the model-facing renderer
   * (lib/partners/render-context.ts renderTier2) can label borrowed partners
   * ("Borrowed from: X, ~Y km from <requestedCity>") without needing the
   * original ResolvedPartnerSet — toModelOutput only sees this output.
   */
  requestedCity: string;
  /**
   * Effective includeContactInShortlist used to build `recommendations`,
   * carried through for the same reason as `requestedCity` — toModelOutput
   * only sees execute()'s return value, not the original tool input.
   */
  includeContactInShortlist: boolean;
  /** Honest-count accounting (R13 §4.3) — all computed in code, never by the LLM. */
  counts: {
    homeTotal: number;
    /** Tag-overlap count when tags were supplied, else the relevance cutoff. */
    homeQualified: number;
    shown: number;
    resolvedTotal: number;
  };
  /** True when fewer than shortlistMin partners qualified — the shortlist is
   *  "closest available", disclosed as such, never silent padding. */
  fitMismatch: boolean;
}

export interface HydratedProfile {
  name: string;
  city: string | null;
  llmProfile: string;
}

export interface BuildRecommendationsDeps {
  convex?: ConvexBackend;
  /** Injectable batch hydration; defaults to ONE get_partner_profiles RPC call. */
  getPartnerProfiles?: (ids: number[]) => Promise<Map<number, HydratedProfile>>;
  /**
   * Pre-fetched profiles (R13 §7 cache restructure): when the search cache
   * already holds the hydrated profile map for the resolved set, pass it here
   * and no RPC runs at all. Ids missing from the map fall back to the RPC
   * path only if `getPartnerProfiles` would have been called anyway.
   */
  profiles?: Map<number, HydratedProfile>;
  /** Bounds the default `get_partner_profiles` RPC call. Ignored when
   * `getPartnerProfiles` is injected — the caller owns cancellation there. */
  signal?: AbortSignal;
}

export async function buildRecommendations(
  input: BuildRecommendationsInput,
  deps: BuildRecommendationsDeps = {},
): Promise<BuildRecommendationsOutput> {
  const { set } = input;
  const warnings: string[] = [...set.meta.warnings];

  // Ranking policy for the final shortlist (R13 §4 — presentation-level
  // relevance ranking; the resolved set itself is untouched, rule #1):
  //  1) HOME partners first (home-city priority is non-negotiable), ordered by
  //     relevance desc (unscored partners keep their stable fetch order
  //     relative to each other, after scored ones), id asc;
  //  2) then NEARBY by relevance desc (falling back to match_partners'
  //     similarity), tiebreak: smaller distanceKm, then id asc.
  const rankScore = (p: PartnerLite): number | undefined => p.relevance ?? p.similarity;
  const byScoreDesc = (a: PartnerLite, b: PartnerLite): number => {
    const sa = rankScore(a);
    const sb = rankScore(b);
    if (sa !== undefined && sb !== undefined) return sb - sa; // 0 on tie → next key
    if (sa !== undefined) return -1; // scored beats unscored
    if (sb !== undefined) return 1;
    return 0; // both unscored → next key / stable input order
  };
  const rankedHome = [...set.home].sort(byScoreDesc); // stable: unscored keep fetch order
  const rankedFilled = [...set.filled].sort(
    (a, b) =>
      byScoreDesc(a, b) ||
      (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY) ||
      a.id - b.id,
  );
  // MERGE ORDER (R13 §4, verified live 2026-08-20): when home partners carry
  // relevance scores, rank the merged list by score — home wins ties — so a
  // relevant borrowed partner outranks an irrelevant home one. Block order
  // ("all home first") displaced every borrowed Kletter partner behind 12
  // off-category Yoga studios in the Köln live test: the shortlist filled
  // with irrelevant home partners while the relevant borrows sat unshown.
  // When home is UNSCORED (embedding down / legacy sets), keep the historical
  // home-block-first order — unscored home must never lose to scored nearby.
  const ranked: PartnerLite[] = set.meta.homeScored
    ? [...rankedHome, ...rankedFilled].sort(
        (a, b) =>
          byScoreDesc(a, b) ||
          (a.source === b.source ? 0 : a.source === "home" ? -1 : 1) ||
          a.id - b.id,
      )
    : [...rankedHome, ...rankedFilled];

  // Shortlist size (R13 §4.2): the relevant population, floored at
  // shortlistMin (fit-mismatch fallback) and capped by the presentation cap
  // and the per-turn budget allotment. All deterministic; the LLM never sizes.
  const homeTotal = set.home.length;
  const homeQualified = set.meta.homeQualified ?? homeTotal;
  const relevantCount = homeQualified + set.filled.length;
  const shortlistMin = Math.max(1, input.shortlistMin ?? DEFAULT_CONFIG.shortlistMin);
  const presentationCap = Math.max(0, Math.floor(input.finalRecommendations));
  const budgetCap = input.maxShown === undefined ? Number.POSITIVE_INFINITY : Math.max(0, input.maxShown);
  const hardCap = Math.min(presentationCap, budgetCap, ranked.length);
  // A fit mismatch means "more partners exist than actually match this
  // request, and the matches are fewer than the floor" — a 2-partner city
  // fully shown is thin coverage (minMet handles that), not a mismatch.
  const fitMismatch = relevantCount < shortlistMin && ranked.length > relevantCount;
  const k = Math.min(hardCap, Math.max(shortlistMin, relevantCount));
  const chosen = ranked.slice(0, k); // E11: never invent — may be fewer than k

  const getPartnerProfilesFn =
    deps.getPartnerProfiles ??
    ((ids: number[]) => defaultGetPartnerProfiles(ids, deps.convex ?? getConvex(), deps.signal));

  let profiles = new Map<number, HydratedProfile>();
  if (chosen.length > 0) {
    const prefetched = deps.profiles;
    if (prefetched && chosen.every((c) => prefetched.has(c.id))) {
      profiles = prefetched; // cache-restructure path: zero DB work (R13 §7)
    } else {
      try {
        profiles = await getPartnerProfilesFn(chosen.map((c) => c.id)); // ONE batch call
      } catch (err) {
        warnings.push(
          `Profile hydration failed (${err instanceof Error ? err.message : String(err)}); using search summaries instead.`,
        );
      }
    }
  }

  // A SHORT hydration return is not an error and must never pass silently.
  // `get_partner_profiles` carried a hardcoded `limit 10` for a long time, so
  // a 100-id request came back with 10 rows and a successful status. Nothing
  // downstream could tell that apart from a complete result.
  if (chosen.length > 0 && profiles.size < chosen.length) {
    warnings.push(
      `Profile hydration returned ${profiles.size} of ${chosen.length} requested profile(s).`,
    );
  }

  const hydrated: Recommendation[] = chosen.map((c) => {
    const profile = profiles.get(c.id);
    return {
      partnerId: c.id,
      name: profile?.name ?? c.name,
      city: profile?.city ?? c.city,
      source: c.source,
      sourceCity: c.sourceCity,
      distanceKm: c.distanceKm,
      similarity: c.similarity,
      llmProfile: profile?.llmProfile ?? c.summary,
    };
  });

  // NEVER hand the model a partner it cannot describe. The `?? c.summary`
  // fallback above degrades gracefully for HOME partners (whose `summary` is
  // the real cleaned body_markdown) but yields "" for NEARBY ones —
  // match_partners does not return body_markdown, so similaritySearchPartners
  // sets it null. A name and city with no profile text, handed to a model
  // under instruction to cite "a concrete, specific detail", is the exact
  // setup that produced the fabrication incident in CLAUDE.md §11. One
  // partner fewer is honest; a blank one is an invitation to invent.
  const recommendations = hydrated.filter((r) => r.llmProfile.trim().length > 0);
  const dropped = hydrated.length - recommendations.length;
  if (dropped > 0) {
    warnings.push(`${dropped} partner(s) omitted for missing profile content.`);
  }

  const counts = {
    homeTotal,
    homeQualified,
    shown: recommendations.length,
    resolvedTotal: set.home.length + set.filled.length,
  };

  return {
    recommendations,
    disclosure: buildDisclosure(set, recommendations, counts, fitMismatch),
    warnings,
    requestedCity: set.requestedCity.canonical,
    includeContactInShortlist:
      input.includeContactInShortlist ?? DEFAULT_CONFIG.includeContactInShortlist,
    counts,
    fitMismatch,
  };
}

export async function defaultGetPartnerProfiles(
  ids: number[],
  convex: ConvexBackend = getConvex(),
  signal?: AbortSignal,
): Promise<Map<number, HydratedProfile>> {
  const map = new Map<number, HydratedProfile>();
  if (ids.length === 0) return map;

  let rows;
  try {
    rows = await convex.getPartnerProfiles(ids, { signal });
  } catch (err) {
    throw new Error(
      `buildRecommendations: partners:getPartnerProfiles failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const row of rows) {
    map.set(row.partner_id, {
      name: row.title,
      city: row.city,
      llmProfile: row.llm_profile ?? "",
    });
  }
  return map;
}

/**
 * Compose an honest one-liner the agent can weave into its reply.
 *
 * Counts are derived from `shown` — the shortlist the model actually receives
 * — NOT from `set`. Those two diverge whenever `finalRecommendations` is
 * smaller than the resolved set (the argument is model-controlled, and the
 * system prompt actively encourages narrowing) or when a partner was dropped
 * for missing profile content. Reporting `set` counts there produced a
 * disclosure claiming borrowed partners that never appeared in the list — a
 * direct breach of the product's honesty invariant. The resolved-set total is
 * still disclosed, but explicitly, as "of N found".
 */
function buildDisclosure(
  set: ResolvedPartnerSet,
  shown: Recommendation[],
  counts: { homeTotal: number; homeQualified: number; shown: number; resolvedTotal: number },
  fitMismatch: boolean,
): string {
  if (set.requestedCity.aliases.length === 0) {
    return `No partners are listed for "${set.requestedCity.input}".`;
  }

  const homeCity = set.requestedCity.canonical;
  const shownHome = shown.filter((r) => r.source === "home");
  const shownNearby = shown.filter((r) => r.source === "nearby");
  const borrowedCities = [...new Set(shownNearby.map((r) => r.sourceCity))].filter(
    (c) => c !== homeCity,
  );
  const parts: string[] = [];

  // R13 §4.3 — the honest four-count framing: total in the city, how many
  // match THIS request, what is shown, what is available on request. All
  // computed here; the model only paraphrases these numbers, never counts.
  if (counts.homeTotal > 0) {
    const qualifier =
      counts.homeQualified < counts.homeTotal
        ? `, ${counts.homeQualified} matching this request`
        : "";
    // Terse when nothing is hidden: "N in X" alone means all of them are shown.
    const showing =
      qualifier === "" && shownHome.length === counts.homeTotal
        ? ""
        : `; showing ${shownHome.length}`;
    parts.push(`${counts.homeTotal} in ${homeCity}${qualifier}${showing}`);
  }
  if (shownNearby.length > 0 && borrowedCities.length > 0) {
    const distances = shownNearby
      .filter((p) => p.distanceKm !== undefined)
      .map((p) => p.distanceKm as number);
    const roughKm = distances.length > 0 ? ` (~${Math.round(Math.min(...distances))} km)` : "";
    parts.push(`${shownNearby.length} nearby from ${borrowedCities.join(", ")}${roughKm}`);
  }

  let line = parts.length ? `Partners: ${parts.join("; ")}.` : "";

  // The working set was larger than what is shown — say so, so the list is
  // never implied to be exhaustive (non-negotiable rule #5).
  const notShown = counts.resolvedTotal - counts.shown;
  if (counts.shown > 0 && notShown > 0) {
    line += ` ${notShown} more available on request.`;
  }

  if (fitMismatch) {
    line += ` No strong matches for this request in ${homeCity} — showing the closest available.`;
  } else if (!set.meta.minMet) {
    line += ` Coverage near ${homeCity} is limited — showing the best ${counts.shown} found.`;
  }

  return line.trim();
}
