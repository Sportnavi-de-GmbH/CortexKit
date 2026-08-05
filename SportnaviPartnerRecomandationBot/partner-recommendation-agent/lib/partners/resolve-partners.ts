/**
 * lib/partners/resolve-partners.ts
 *
 * THE ORCHESTRATOR — Steps 2-5 of the canonical algorithm
 * (eve-agent-plan/pseudocode/partner-injection.pseudo.md). Encodes the
 * prioritize-then-gap-fill algorithm deterministically so the LLM can't
 * miscount, forget to dedupe, or overshoot the city budget.
 *
 * Golden rule: the home city is taken WHOLE and never similarity-filtered.
 * Similarity search is used ONLY to fill the missing gap from nearby cities
 * (and, as an explicit configured exception, to re-rank an oversized home
 * city in overflow_trim's "similarity-overflow" strategy).
 *
 * Every leaf dependency is injectable so unit tests run fully mocked, never
 * touching Supabase. Ported from eve-agent-plan/agent/tools/resolve-partners.ts
 * (design reference, read-only), adapted to the REAL leaf function
 * signatures verified in M3a (see get-partners-by-city.ts,
 * find-nearby-cities.ts, similarity-search-partners.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { performance } from "node:perf_hooks";
import {
  mergeConfig,
  type PartnerInjectionConfig,
} from "../../agent/config/partner-injection.config";
import type { TtlCache } from "../cache";
import type {
  PartnerRow,
  PartnerLite,
  ResolvedCity,
  Intent,
  ResolvedPartnerSet,
  ResolutionMeta,
} from "./types";
import { getPartnersByCity } from "./get-partners-by-city";
import { findNearbyCities } from "./find-nearby-cities";
import { similaritySearchPartners } from "./similarity-search-partners";
import { embedText } from "../embeddings";
import { timeoutSignal } from "../timeout";

// Per-stage timeouts (production-readiness review item 5: no timeout existed
// anywhere on these dependencies). Each stage gets its own fresh AbortSignal
// at the point of the call rather than one shared per-request signal, so a
// slow home fetch can't eat into the nearby-cities budget and vice versa —
// gap-fill already tolerates a single slow/failing city via Promise.allSettled
// below, and a per-city timeout preserves that resilience instead of letting
// one hung city block the others. All four are well inside the outer 15s
// deadline agent/tools/find_partners.ts wraps the whole pipeline in.
const HOME_FETCH_TIMEOUT_MS = 5_000;
const NEARBY_CITIES_TIMEOUT_MS = 3_000;
const PER_CITY_SEARCH_TIMEOUT_MS = 4_000;

export interface ResolvePartnersInput {
  city: ResolvedCity;
  intent: Intent;
  /** Overrides merged over DEFAULT_CONFIG via mergeConfig (Step 0). */
  config?: Partial<PartnerInjectionConfig>;
}

/** A ranking function used ONLY by overflow_trim's "similarity-overflow" strategy. */
export type RankHomeBySimilarityFn = (
  home: PartnerLite[],
  intent: Intent,
  homeCity: string,
) => Promise<Map<number, number>>;

export interface ResolvePartnersDeps {
  supabase?: SupabaseClient;
  getPartnersByCityFn?: typeof getPartnersByCity;
  findNearbyCitiesFn?: typeof findNearbyCities;
  similaritySearchPartnersFn?: typeof similaritySearchPartners;
  /** Injectable TTL cache, forwarded to findNearbyCitiesFn. */
  cache?: TtlCache<unknown>;
  /** Injectable monotonic clock — defaults to performance.now. */
  now?: () => number;
  /** Opt-in golden-rule exception used only by overflowStrategy: "similarity-overflow". */
  rankHomeBySimilarity?: RankHomeBySimilarityFn;
  /** Injectable embedder — defaults to lib/embeddings.embedText. Embedded ONCE
   *  per search and shared across the concurrent gap-fill fan-out. Injectable
   *  so the unit suite stays fully mocked and never touches the network. */
  embedTextFn?: typeof embedText;
}

export async function resolvePartners(
  input: ResolvePartnersInput,
  deps: ResolvePartnersDeps = {},
): Promise<ResolvedPartnerSet> {
  const now = deps.now ?? (() => performance.now());
  const timingsMs: Record<string, number> = {};
  const timeStage = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const start = now();
    try {
      return await fn();
    } finally {
      timingsMs[stage] = (timingsMs[stage] ?? 0) + (now() - start);
    }
  };

  const supabase = deps.supabase; // may be undefined; leaf fns fall back to getSupabase()
  const getPartnersByCityFn = deps.getPartnersByCityFn ?? getPartnersByCity;
  const findNearbyCitiesFn = deps.findNearbyCitiesFn ?? findNearbyCities;
  const similaritySearchPartnersFn = deps.similaritySearchPartnersFn ?? similaritySearchPartners;
  const embedTextFn = deps.embedTextFn ?? embedText;
  const rankHomeBySimilarity: RankHomeBySimilarityFn =
    deps.rankHomeBySimilarity ??
    ((home, intent, homeCity) =>
      defaultRankHomeBySimilarity(home, intent, homeCity, similaritySearchPartnersFn, supabase));

  const warnings: string[] = [];

  // ── Step 0: validate/normalize config (fail fast; clamp min>max) ─────────
  const { config: cfg, warnings: cfgWarnings } = mergeConfig(input.config);
  warnings.push(...cfgWarnings);

  const { city, intent } = input;

  // ── Step 2: take the home city WHOLE (no ranking, no trimming) ───────────
  const tagFilter = cfg.requireTagMatch && intent.tags.length > 0 ? intent.tags : undefined;
  // Home fetch failure is a HARD error — never caught, never skip the home city.
  const homeRows = await timeStage("homeFetch", () =>
    getPartnersByCityFn(
      { aliases: city.aliases, tagFilter, includeInactive: cfg.includeInactive },
      supabase as SupabaseClient,
      { signal: timeoutSignal(HOME_FETCH_TIMEOUT_MS) },
    ),
  );

  const dedupedHome = dedupeById(homeRows);
  let home: PartnerLite[] = dedupedHome.map((r) => toLite(r, "home", city.canonical));
  const seenIds = new Set<number>(home.map((p) => p.id));

  // ── Step 3: home already enough? ──────────────────────────────────────────
  if (home.length >= cfg.minPartners) {
    let cappedAtMax = false;
    if (home.length > cfg.maxPartners) {
      home = await timeStage("overflowTrim", () =>
        overflowTrim(home, dedupedHome, cfg, { intent, homeCity: city.canonical, rankHomeBySimilarity }),
      );
      cappedAtMax = true;
      warnings.push(
        `Home city has ${dedupedHome.length} partner(s); trimmed to ${cfg.maxPartners} via "${cfg.overflowStrategy}".`,
      );
    }
    return buildResult(city, home, [], [city.canonical], cfg, warnings, timingsMs, {
      minMet: true,
      cappedAtMax,
      citiesExhausted: false,
    });
  }

  // ── Step 4: fill ONLY the gap from nearby cities ──────────────────────────
  let gap = cfg.minPartners - home.length;
  let neighbors: Awaited<ReturnType<typeof findNearbyCities>>;
  try {
    neighbors = await timeStage("nearbyCities", () =>
      findNearbyCitiesFn(
        { home: city, limit: cfg.maxCities - 1, maxDistanceKm: cfg.maxDistanceKm },
        { supabase, cache: deps.cache as never, signal: timeoutSignal(NEARBY_CITIES_TIMEOUT_MS) },
      ),
    );
  } catch (err) {
    // Only the HOME fetch is a hard error. A failing neighbor lookup must
    // degrade to a partial (home-only) result + warning — never a stack
    // trace to the user.
    warnings.push(
      `Nearby-city lookup failed — returning home-only result (${err instanceof Error ? err.message : String(err)}).`,
    );
    return buildResult(city, home, [], [city.canonical], cfg, warnings, timingsMs, {
      minMet: home.length >= cfg.minPartners,
      cappedAtMax: false,
      citiesExhausted: true,
    });
  }

  const filled: PartnerLite[] = [];
  const citiesUsed: string[] = [city.canonical];
  let floorRejects = 0;

  await timeStage("gapFill", async () => {
    // The candidate cities are searched CONCURRENTLY. Each query targets a
    // different city and they share no state — the running `gap`, `seenIds`
    // and `citiesUsed` are all applied afterwards, as filters over the
    // combined result, never as inputs to the query. Serially, one slow or
    // timing-out city burned its full timeout before the next one even
    // started; this is the worst-latency path in the product (thin cities).
    //
    // Two consequences, both deliberate:
    //  - `k` is sized from the INITIAL gap for every city rather than the
    //    running one, so we may fetch a few more candidates than strictly
    //    needed. Cheap; the surplus is discarded by the same filters below.
    //  - allSettled, not all: a failing city must be skipped with a warning,
    //    never abort the search. Same resilience the serial loop had (E24).
    const budget = Math.max(0, cfg.maxCities - citiesUsed.length);
    const candidates = neighbors.slice(0, budget);
    const initialGap = gap;

    // Embed the intent ONCE for the whole fan-out. Every candidate city
    // searches the same `intent.text`, but the embedding cache in
    // lib/embeddings.ts only fills after the first call RESOLVES — so N
    // concurrent searches all missed and issued N identical embedding
    // requests, N times the latency exposure and N chances to fail.
    let queryEmbedding: number[] | null = null;
    let embeddingWarning: string | undefined;
    if (candidates.length > 0) {
      try {
        queryEmbedding = await embedTextFn(intent.text, { signal: timeoutSignal(PER_CITY_SEARCH_TIMEOUT_MS) });
      } catch (err) {
        queryEmbedding = null;
        embeddingWarning = `embedding unavailable (${err instanceof Error ? err.message : String(err)}); degraded to text-only search`;
      }
    }

    const settled = await Promise.allSettled(
      candidates.map((nc) =>
        similaritySearchPartnersFn(
          {
            city: nc.city,
            intent,
            k: initialGap + cfg.dedupHeadroom, // demand-driven; never over-fetch (E26)
            requireTagMatch: cfg.requireTagMatch,
            queryEmbedding,
            embeddingWarning,
          },
          supabase as SupabaseClient,
          { signal: timeoutSignal(PER_CITY_SEARCH_TIMEOUT_MS) },
        ),
      ),
    );

    // Consume in nearest-first order so the selection stays deterministic and
    // identical to the serial version: closer cities still win the gap.
    for (let i = 0; i < candidates.length; i++) {
      const nc = candidates[i]!;
      if (gap <= 0) break; // minimum reached
      if (citiesUsed.length >= cfg.maxCities) break; // city budget spent (E29)

      const outcome = settled[i]!;
      if (outcome.status === "rejected") {
        const err = outcome.reason;
        warnings.push(
          `Search failed for "${nc.city}"; skipped (${err instanceof Error ? err.message : String(err)}).`,
        );
        continue;
      }
      const hits = outcome.value.hits;
      warnings.push(...outcome.value.warnings); // e.g. embedding-degrade (E25)

      let usedThisCity = false;
      for (const hit of hits) {
        if (gap <= 0) break;
        if (seenIds.has(hit.id)) continue; // dedupe across cities, home wins (E8)
        if (hit.similarity < cfg.similarityThreshold) {
          floorRejects++; // relevance floor (E9)
          continue;
        }
        filled.push({
          id: hit.id,
          name: hit.name,
          city: hit.city,
          tags: hit.tags_norm ?? [],
          summary: cleanBody(hit.body_markdown),
          website_url: hit.website_url,
          source: "nearby",
          sourceCity: nc.city,
          similarity: hit.similarity,
          distanceKm: nc.distanceKm,
        });
        seenIds.add(hit.id);
        gap -= 1;
        usedThisCity = true;
      }
      if (usedThisCity && !citiesUsed.includes(nc.city)) citiesUsed.push(nc.city);
    }
  });

  if (floorRejects > 0)
    warnings.push(`${floorRejects} nearby candidate(s) rejected below similarity floor.`);

  const minMet = home.length + filled.length >= cfg.minPartners;
  const citiesExhausted = !minMet; // ran out of cities/candidates before min (E13)
  if (!minMet)
    warnings.push(
      `Only ${home.length + filled.length} partner(s) found near "${city.canonical}" (wanted ${cfg.minPartners}).`,
    );

  // ── Step 5: cap at maxPartners (home survives first; filled truncated) ───
  let outHome = home;
  let outFilled = filled;
  const total = outHome.length + outFilled.length;
  let cappedAtMax = false;
  if (total > cfg.maxPartners) {
    cappedAtMax = true;
    // Defensive / faithful-to-pseudocode: at this point in Step 5, home.length
    // is always < cfg.minPartners <= cfg.maxPartners (post Step-0 clamp) — we
    // only reach here via the Step-4 gap-fill path, whose home was already
    // below minPartners. This branch mirrors the pseudocode's `overflow_trim`
    // call at Step 5 and only fires if that invariant is ever broken upstream.
    if (outHome.length >= cfg.maxPartners) {
      outHome = await timeStage("overflowTrim", () =>
        overflowTrim(outHome, dedupedHome, cfg, { intent, homeCity: city.canonical, rankHomeBySimilarity }),
      );
      outFilled = [];
    } else {
      outFilled = outFilled.slice(0, cfg.maxPartners - outHome.length);
    }
  }

  return buildResult(city, outHome, outFilled, citiesUsed, cfg, warnings, timingsMs, {
    minMet,
    cappedAtMax,
    citiesExhausted,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function dedupeById(rows: PartnerRow[]): PartnerRow[] {
  const byId = new Map<number, PartnerRow>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

function toLite(r: PartnerRow, source: "home" | "nearby", sourceCity: string): PartnerLite {
  return {
    id: r.id,
    name: r.name,
    city: r.city,
    tags: r.tags_norm ?? [],
    summary: cleanBody(r.body_markdown),
    website_url: r.website_url,
    source,
    sourceCity,
    // NOTE: email/phone are never selected by get-partners-by-city.ts (no PII here).
  };
}

/**
 * Clean the full body_markdown for context injection. NO truncation — the
 * complete content goes to the model; only markdown noise is stripped
 * (treat as data, not instructions).
 */
function cleanBody(md: string | null): string {
  if (!md) return "";
  return md.replace(/[#>*_`|]/g, " ").replace(/\s+/g, " ").trim();
}

/** Deterministic FNV-1a-style hash for stable pseudo-random ordering (NO Math.random). */
export function stableHash(id: number): number {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface OverflowTrimContext {
  intent: Intent;
  homeCity: string;
  rankHomeBySimilarity: RankHomeBySimilarityFn;
}

/**
 * The ONE allowed home-city trim, used only when the home city alone exceeds
 * maxPartners. Governed by cfg.overflowStrategy. Deterministic tiebreak
 * everywhere: secondary sort by id asc. See docs/03 Step 5 + pseudocode
 * `overflow_trim`.
 */
export async function overflowTrim(
  home: PartnerLite[],
  homeRows: PartnerRow[],
  cfg: PartnerInjectionConfig,
  ctx: OverflowTrimContext,
): Promise<PartnerLite[]> {
  const byId = new Map(homeRows.map((r) => [r.id, r]));
  const scored = [...home];

  switch (cfg.overflowStrategy) {
    case "quality":
      scored.sort((a, b) => {
        const qa = byId.get(a.id)?.quality_score ?? null;
        const qb = byId.get(b.id)?.quality_score ?? null;
        if (qa === null && qb === null) return a.id - b.id;
        if (qa === null) return 1; // nulls last
        if (qb === null) return -1;
        return qb - qa || a.id - b.id;
      });
      break;

    case "recency":
      scored.sort((a, b) => {
        const ra = byId.get(a.id)?.updated_at ?? null;
        const rb = byId.get(b.id)?.updated_at ?? null;
        if (ra === null && rb === null) return a.id - b.id;
        if (ra === null) return 1; // nulls last
        if (rb === null) return -1;
        return rb.localeCompare(ra) || a.id - b.id; // ISO-8601 strings compare desc
      });
      break;

    case "random-stable":
      scored.sort((a, b) => stableHash(a.id) - stableHash(b.id) || a.id - b.id);
      break;

    case "similarity-overflow": {
      // Opt-in golden-rule exception: re-rank home by relevance to the intent.
      const scores = await ctx.rankHomeBySimilarity(home, ctx.intent, ctx.homeCity);
      scored.sort((a, b) => {
        const sa = scores.get(a.id);
        const sb = scores.get(b.id);
        if (sa !== undefined && sb !== undefined) return sb - sa || a.id - b.id;
        if (sa !== undefined) return -1; // ranked beats unranked
        if (sb !== undefined) return 1;
        return stableHash(a.id) - stableHash(b.id) || a.id - b.id; // both missing
      });
      break;
    }
  }

  return scored.slice(0, cfg.maxPartners);
}

/**
 * Default rank function for overflowStrategy "similarity-overflow": scores
 * the home city's own partners against the intent via similaritySearchPartners
 * scoped to the home city, k = home.length (need every home id ranked).
 */
async function defaultRankHomeBySimilarity(
  home: PartnerLite[],
  intent: Intent,
  homeCity: string,
  similaritySearchPartnersFn: typeof similaritySearchPartners,
  supabase: SupabaseClient | undefined,
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (home.length === 0) return map;
  const result = await similaritySearchPartnersFn(
    { city: homeCity, intent, k: home.length },
    supabase as SupabaseClient,
    { signal: timeoutSignal(PER_CITY_SEARCH_TIMEOUT_MS) },
  );
  for (const hit of result.hits) map.set(hit.id, hit.similarity);
  return map;
}

function buildResult(
  city: ResolvedCity,
  home: PartnerLite[],
  filled: PartnerLite[],
  citiesUsed: string[],
  cfg: PartnerInjectionConfig,
  warnings: string[],
  timingsMs: Record<string, number>,
  flags: { minMet: boolean; cappedAtMax: boolean; citiesExhausted: boolean },
): ResolvedPartnerSet {
  const meta: ResolutionMeta = {
    minRequired: cfg.minPartners,
    maxAllowed: cfg.maxPartners,
    maxCities: cfg.maxCities,
    totalReturned: home.length + filled.length,
    minMet: flags.minMet,
    cappedAtMax: flags.cappedAtMax,
    citiesExhausted: flags.citiesExhausted,
    warnings,
    timingsMs,
  };
  return { requestedCity: city, home, filled, citiesUsed, meta };
}
