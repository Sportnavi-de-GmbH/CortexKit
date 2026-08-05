/**
 * lib/partners/find-nearby-cities.ts
 *
 * Given the home city, return other cities ordered nearest-first, each with
 * its available (active) partner count. There is no `cities` table and no
 * geo index, so city centroids are derived from partner lat/long and ranked
 * by Haversine distance. Results are cached (centroids change rarely).
 *
 * Ported from eve-agent-plan/agent/tools/find-nearby-cities.ts (design
 * reference, read-only). No RPC exists for the per-city aggregate, so this
 * fetches minimal columns (city, latitude, longitude) for active rows and
 * aggregates in JS, as instructed. 3 active rows lack coordinates (verified
 * live) and are skipped by the `not.is.null` filters below.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import { createTtlCache, type TtlCache } from "../cache";
import { DEFAULT_CONFIG } from "../../agent/config/partner-injection.config";
import type { NearbyCity, ResolvedCity } from "./types";

export interface FindNearbyCitiesInput {
  home: ResolvedCity; // needs a centroid; if null → returns [] (E15/E17)
  limit: number; // typically maxCities - 1
  maxDistanceKm: number | null;
}

export interface FindNearbyCitiesDeps {
  supabase?: SupabaseClient;
  /** Injectable TTL cache — defaults to a module-level singleton whose TTL
   * comes from PartnerInjectionConfig.neighborsCacheTtlSec. */
  cache?: TtlCache<CityCentroid[]>;
  /** Bounds the `city_centroids()` RPC call. Not applied on a cache hit —
   * there's no I/O to bound. */
  signal?: AbortSignal;
}

interface CityCentroid {
  city: string; // canonical display label
  centroid: { lat: number; lng: number };
  count: number; // active partners with coords
}

const CENTROIDS_CACHE_KEY = "city-centroids";

/** Module-level default cache, shared across calls within a process. TTL
 * comes from PartnerInjectionConfig.neighborsCacheTtlSec; an injected
 * `deps.cache` still wins over this default. */
const defaultCache = createTtlCache<CityCentroid[]>(DEFAULT_CONFIG.neighborsCacheTtlSec);

/** Collapse alias-spellings into one node (E21): lowercase + transliterate. */
export function normalizeCityKey(city: string): string {
  return city
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ");
}

/** Straight-line distance between two WGS84 points, in km. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const toRad = (d: number) => (d * Math.PI) / 180;

interface CityCentroidRow {
  city: string | null;
  lat: number | null;
  lon: number | null;
  cnt: number | null;
}

/**
 * Aggregates city centroids via the `city_centroids()` RPC.
 *
 * This used to `select("city, latitude, longitude")` over every active partner
 * and group in JS. That query is unbounded, and PostgREST silently caps an
 * unbounded response at its `db-max-rows` default of 1,000 — so with 2,317
 * eligible rows the client received a truncated window covering only 334 of
 * 648 cities (verified live, deterministic across runs). The consequences were
 * all silent: 314 cities could never be borrowed from, centroids of the cities
 * that *did* make it were averaged over a partial row set (corrupting every
 * Haversine distance and therefore the maxDistanceKm filter), `availableCount`
 * was understated, and the whole wrong map was cached for 24 h.
 *
 * Aggregating server-side removes the row cap and the 2,300-row transfer, and
 * collapses umlaut spelling variants via `slugify_tag` — the same intent as
 * {@link normalizeCityKey}, which is retained below for home/alias matching.
 */
async function getCityCentroids(
  supabase: SupabaseClient,
  cache: TtlCache<CityCentroid[]>,
  signal?: AbortSignal,
): Promise<CityCentroid[]> {
  const cached = cache.get(CENTROIDS_CACHE_KEY);
  if (cached) return cached;

  let query = supabase.rpc("city_centroids");
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) {
    throw new Error(`getCityCentroids: city_centroids RPC failed: ${error.message}`);
  }

  // Defense in depth: the RPC already excludes null city/coords, but skip any
  // row lacking them here too rather than trust that alone.
  const result: CityCentroid[] = ((data ?? []) as CityCentroidRow[])
    .filter(
      (r): r is { city: string; lat: number; lon: number; cnt: number } =>
        r.city !== null && r.lat !== null && r.lon !== null && r.cnt !== null,
    )
    .map((r) => ({
      city: r.city,
      centroid: { lat: r.lat, lng: r.lon },
      count: r.cnt,
    }));

  cache.set(CENTROIDS_CACHE_KEY, result);
  return result;
}

export async function findNearbyCities(
  input: FindNearbyCitiesInput,
  deps: FindNearbyCitiesDeps = {},
): Promise<NearbyCity[]> {
  if (!input.home.centroid) return []; // can't distance-rank without coords (E17)

  const supabase = deps.supabase ?? getSupabase();
  const cache = deps.cache ?? defaultCache;
  const centroids = await getCityCentroids(supabase, cache, deps.signal);

  const homeKey = normalizeCityKey(input.home.canonical);
  const homeAliasKeys = new Set(input.home.aliases.map(normalizeCityKey));

  const out: NearbyCity[] = [];
  for (const c of centroids) {
    const key = normalizeCityKey(c.city);
    if (key === homeKey || homeAliasKeys.has(key)) continue; // exclude home (E21)

    const distanceKm = haversineKm(input.home.centroid, c.centroid);
    if (input.maxDistanceKm !== null && distanceKm > input.maxDistanceKm) continue; // E6/E15

    out.push({
      city: c.city,
      centroid: c.centroid,
      distanceKm,
      availableCount: c.count,
    });
  }

  // Nearest first; deterministic tiebreak: more supply, then name asc (E16).
  out.sort(
    (a, b) =>
      a.distanceKm - b.distanceKm ||
      b.availableCount - a.availableCount ||
      a.city.localeCompare(b.city),
  );

  return out.slice(0, Math.max(0, input.limit));
}
