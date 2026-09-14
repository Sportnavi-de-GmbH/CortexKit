// V3 COPY — copied from ../partner-recommendation-agent-v2/search/nearby-cities.ts on 2026-09-14
// (only the two relative imports changed to sibling paths). V3 never imports from V2's tree.
/**
 * search/nearby-cities.ts — which cities count as "nearby" for a request.
 *
 * Uses the SAME location data as the existing agent: the directory's
 * `city_centroids()` function (one centroid + active-partner count per city),
 * ranked by Haversine distance from the requested city's centroid, bounded
 * by `maxDistanceKm`. The selection is the `limit` NEAREST cities plus the
 * `hubs` best-supplied cities inside the radius, where supply is weighted by
 * distance (`partners / (1 + km/30)`) — so a big city like Bochum, 17 km from
 * Dortmund, is not crowded out by five tiny towns that happen to be closer,
 * and a huge city at the edge of the radius does not beat a large one next
 * door. No hand-written city lists.
 *
 * The Haversine and alias-normalization helpers are the existing agent's
 * (lib/partners/find-nearby-cities.ts), re-implemented here verbatim so V2
 * does not import from the existing agent's tree.
 */

import type { SupabaseBackend } from "./supabase";
import { createTtlCache, type TtlCache } from "./cache";

export interface NearbyCity {
  city: string;
  centroid: { lat: number; lng: number };
  distanceKm: number;
  partnerCount: number;
}

interface CityCentroid {
  city: string;
  centroid: { lat: number; lng: number };
  count: number;
}

const CENTROIDS_CACHE_KEY = "city-centroids";
/** Hub ranking: a city's partner count is discounted by (1 + km / this). */
const HUB_DISTANCE_SCALE_KM = 30;
const CENTROIDS_TTL_SEC = 86_400; // centroids change only on a partner import
const defaultCache = createTtlCache<CityCentroid[]>(CENTROIDS_TTL_SEC);

/** Collapse alias spellings (umlauts, case, whitespace) into one key. */
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

const toRad = (d: number) => (d * Math.PI) / 180;

/** Straight-line distance between two WGS84 points, in km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

async function getCityCentroids(
  backend: SupabaseBackend,
  cache: TtlCache<CityCentroid[]>,
  signal?: AbortSignal,
): Promise<CityCentroid[]> {
  const cached = cache.get(CENTROIDS_CACHE_KEY);
  if (cached) return cached;
  const rows = await backend.cityCentroids({ signal });
  const result = rows
    .filter((r) => r.city !== null && r.lat !== null && r.lon !== null && r.cnt !== null)
    .map((r) => ({ city: r.city, centroid: { lat: r.lat, lng: r.lon }, count: r.cnt }));
  cache.set(CENTROIDS_CACHE_KEY, result);
  return result;
}

export interface FindNearbyCitiesInput {
  home: { canonical: string; centroid: { lat: number; lng: number } };
  /** How many NEAREST cities to take. */
  limit: number;
  /** How many additional best-supplied cities (most partners) inside the radius to add. */
  hubs?: number;
  maxDistanceKm: number;
}

export async function findNearbyCities(
  input: FindNearbyCitiesInput,
  backend: SupabaseBackend,
  opts: { cache?: TtlCache<CityCentroid[]>; signal?: AbortSignal } = {},
): Promise<NearbyCity[]> {
  const hubs = input.hubs ?? 0;
  if (input.limit <= 0 && hubs <= 0) return [];
  const centroids = await getCityCentroids(backend, opts.cache ?? defaultCache, opts.signal);
  const homeKey = normalizeCityKey(input.home.canonical);

  const out: NearbyCity[] = [];
  for (const c of centroids) {
    if (normalizeCityKey(c.city) === homeKey) continue;
    const distanceKm = haversineKm(input.home.centroid, c.centroid);
    if (distanceKm > input.maxDistanceKm) continue;
    out.push({ city: c.city, centroid: c.centroid, distanceKm, partnerCount: c.count });
  }
  // Nearest first; tiebreak: more supply, then name.
  out.sort(
    (a, b) => a.distanceKm - b.distanceKm || b.partnerCount - a.partnerCount || a.city.localeCompare(b.city),
  );
  const chosen = out.slice(0, Math.max(0, input.limit));
  if (hubs > 0) {
    const hubScore = (c: NearbyCity) => c.partnerCount / (1 + c.distanceKm / HUB_DISTANCE_SCALE_KM);
    const bySupply = out
      .filter((c) => !chosen.includes(c))
      .sort((a, b) => hubScore(b) - hubScore(a) || a.distanceKm - b.distanceKm || a.city.localeCompare(b.city));
    chosen.push(...bySupply.slice(0, hubs));
    chosen.sort((a, b) => a.distanceKm - b.distanceKm || a.city.localeCompare(b.city));
  }
  return chosen;
}

/** Test hook. */
export function clearNearbyCityCache(): void {
  defaultCache.clear();
}
