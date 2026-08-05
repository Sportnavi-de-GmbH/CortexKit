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
 * Ported from eve-agent-plan/agent/tools/build-recommendations.ts (design
 * reference, read-only), adapted to batch-hydrate via get_partner_profiles
 * (the real RPC verified in M3a — see lib/partners/get-partner-details.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
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
  finalRecommendations: number;
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
}

export interface HydratedProfile {
  name: string;
  city: string | null;
  llmProfile: string;
}

export interface BuildRecommendationsDeps {
  supabase?: SupabaseClient;
  /** Injectable batch hydration; defaults to ONE get_partner_profiles RPC call. */
  getPartnerProfiles?: (ids: number[]) => Promise<Map<number, HydratedProfile>>;
  /** Bounds the default `get_partner_profiles` RPC call. Ignored when
   * `getPartnerProfiles` is injected — the caller owns cancellation there. */
  signal?: AbortSignal;
}

interface GetPartnerProfilesRow {
  partner_id: number;
  title: string;
  city: string | null;
  llm_profile: string | null;
}

export async function buildRecommendations(
  input: BuildRecommendationsInput,
  deps: BuildRecommendationsDeps = {},
): Promise<BuildRecommendationsOutput> {
  const { set } = input;
  const warnings: string[] = [...set.meta.warnings];

  // Ranking policy for the final shortlist:
  //  1) home partners first, in the stable order they were fetched …
  //  2) … then nearby by similarity desc, tiebreak: smaller distanceKm, then id asc.
  const rankedFilled = [...set.filled].sort(
    (a, b) =>
      (b.similarity ?? 0) - (a.similarity ?? 0) ||
      (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY) ||
      a.id - b.id,
  );
  const ranked: PartnerLite[] = [...set.home, ...rankedFilled];

  const n = Math.max(0, Math.floor(input.finalRecommendations));
  const chosen = ranked.slice(0, n); // E11: never invent — may be fewer than n

  const getPartnerProfilesFn =
    deps.getPartnerProfiles ??
    ((ids: number[]) => defaultGetPartnerProfiles(ids, deps.supabase ?? getSupabase(), deps.signal));

  let profiles = new Map<number, HydratedProfile>();
  if (chosen.length > 0) {
    try {
      profiles = await getPartnerProfilesFn(chosen.map((c) => c.id)); // ONE batch call
    } catch (err) {
      warnings.push(
        `Profile hydration failed (${err instanceof Error ? err.message : String(err)}); using search summaries instead.`,
      );
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

  return {
    recommendations,
    disclosure: buildDisclosure(set, recommendations),
    warnings,
    requestedCity: set.requestedCity.canonical,
    includeContactInShortlist:
      input.includeContactInShortlist ?? DEFAULT_CONFIG.includeContactInShortlist,
  };
}

export async function defaultGetPartnerProfiles(
  ids: number[],
  supabase: SupabaseClient,
  signal?: AbortSignal,
): Promise<Map<number, HydratedProfile>> {
  const map = new Map<number, HydratedProfile>();
  if (ids.length === 0) return map;

  let query = supabase.rpc("get_partner_profiles", { p_ids: ids });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) {
    throw new Error(`buildRecommendations: get_partner_profiles RPC failed: ${error.message}`);
  }

  const rows = (data ?? []) as GetPartnerProfilesRow[];
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
function buildDisclosure(set: ResolvedPartnerSet, shown: Recommendation[]): string {
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

  if (shownHome.length > 0) parts.push(`${shownHome.length} in ${homeCity}`);
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
  const resolvedTotal = set.home.length + set.filled.length;
  if (shown.length > 0 && resolvedTotal > shown.length) {
    line += ` Showing ${shown.length} of ${resolvedTotal} found.`;
  }

  if (!set.meta.minMet) {
    line += ` Coverage near ${homeCity} is limited — showing the best ${shown.length} found.`;
  }

  return line.trim();
}
