/**
 * Stage 3 — Which cities to search: the target (0 km) plus the nearest
 * cities inside `searchRadiusKm` (+ best-supplied hubs), from the directory's
 * own `city_centroids()`. Ordered by distance, target first.
 */
import { findNearbyCities, haversineKm } from "../../lib/reused/nearby-cities";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { NearbyCitiesOutput, ResolvedCity, SearchCity, StageContext, StageResult } from "../types";

export async function nearbyCities(input: { target: ResolvedCity }, ctx: StageContext): Promise<StageResult<NearbyCitiesOutput>> {
  const c = ctx.config;
  const signal = AbortSignal.any([ctx.signal, timeoutSignal(c.callTimeoutMs)]);
  const home = { canonical: input.target.canonical, centroid: input.target.centroid };

  const nearby = await findNearbyCities(
    { home, limit: c.maxNearbyCities, hubs: c.maxNearbyHubs, maxDistanceKm: c.searchRadiusKm },
    ctx.deps.backend,
    { signal },
  );
  // How many cities lay inside the radius at all (for the UI), independent of the limit.
  const centroids = await ctx.deps.backend.cityCentroids({ signal });
  const withinRadius = centroids.filter(
    (r) => r.city !== input.target.canonical && haversineKm(input.target.centroid, { lat: r.lat, lng: r.lon }) <= c.searchRadiusKm,
  ).length;
  const targetCount = centroids.find((r) => r.city === input.target.canonical)?.cnt ?? 0;

  const cities: SearchCity[] = [];
  if (c.includeTargetCity) cities.push({ city: input.target.canonical, role: "target", distanceKm: 0, partnerCount: targetCount });
  for (const n of nearby) cities.push({ city: n.city, role: "nearby", distanceKm: Math.round(n.distanceKm * 10) / 10, partnerCount: n.partnerCount });

  return {
    output: { cities },
    config: { searchRadiusKm: c.searchRadiusKm, maxNearbyCities: c.maxNearbyCities, maxNearbyHubs: c.maxNearbyHubs, includeTargetCity: c.includeTargetCity },
    counts: { withinRadius, nearbyChosen: nearby.length, citiesToSearch: cities.length },
  };
}
