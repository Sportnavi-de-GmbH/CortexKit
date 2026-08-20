/**
 * convex/cities.ts — ports of the two city-level Postgres RPCs.
 *
 *   resolve_city_fuzzy(place)  ->  cities.resolveCityFuzzy
 *   city_centroids()           ->  cities.cityCentroids
 *
 * Both SQL functions are GROUP BY aggregates over `partners`. Convex has no
 * aggregation, so the groups are materialized into the `citySpellings` and
 * `cityCentroids` tables by convex/migrations.ts:rebuildCityAggregates, and
 * these functions read them. That is a deliberate design choice, not a
 * shortcut — see MIGRATION-NOTES.md §"Aggregates".
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import { slugifyTag } from "./lib/slugify";
import { trigramSimilarity } from "./lib/trigram";

/** Hard ceiling on a full-table read of a city table. Germany has ~650 covered
 *  cities today; this bounds the read if the directory grows an order of
 *  magnitude, and `verifySetup` reports the row count so silent truncation
 *  (the §10.9 PostgREST bug) cannot repeat unnoticed. */
const CITY_SCAN_LIMIT = 5_000;

/**
 * Port of:
 *
 *   select p.city,
 *          percentile_cont(0.5) within group (order by p.latitude)  as lat,
 *          percentile_cont(0.5) within group (order by p.longitude) as lon,
 *          max(similarity(slugify_tag(p.city), slugify_tag(place)))  as sim
 *   from partners p
 *   where p.city is not null and p.latitude is not null
 *     and p.longitude is not null and p.is_active
 *     and similarity(slugify_tag(p.city), slugify_tag(place)) > 0.4
 *   group by p.city
 *   order by sim desc, count(*) desc
 *   limit 1;
 *
 * The GROUP BY, the median lat/lon and the row filters are precomputed into
 * `citySpellings` (one row per exact active spelling that has coordinates).
 * The similarity filter and the ORDER BY have to stay here — they depend on
 * the caller's `place`.
 *
 * Returns AT MOST ONE row, exactly like the SQL (`limit 1`).
 */
export const resolveCityFuzzy = query({
  args: { place: v.string() },
  returns: v.union(
    v.object({
      city: v.string(),
      lat: v.number(),
      lon: v.number(),
      sim: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const placeSlug = slugifyTag(args.place);
    if (placeSlug === "") return null;

    const spellings = await ctx.db.query("citySpellings").take(CITY_SCAN_LIMIT);

    let best: { city: string; lat: number; lon: number; sim: number; count: number } | null =
      null;

    for (const s of spellings) {
      const sim = trigramSimilarity(s.citySlug, placeSlug);
      if (sim <= 0.4) continue; // the RPC's similarity floor — strictly greater

      if (
        best === null ||
        sim > best.sim ||
        (sim === best.sim && s.partnerCount > best.count) ||
        // Not in the SQL: Postgres leaves a full tie unordered. Breaking it on
        // the city name keeps this deterministic, which is a hard requirement
        // of this codebase (CLAUDE.md §12.7).
        (sim === best.sim && s.partnerCount === best.count && s.city < best.city)
      ) {
        best = {
          city: s.city,
          lat: s.medianLat,
          lon: s.medianLon,
          sim,
          count: s.partnerCount,
        };
      }
    }

    if (best === null) return null;
    return { city: best.city, lat: best.lat, lon: best.lon, sim: best.sim };
  },
});

/**
 * Port of the `city_centroids()` RPC: one row per city SLUG with the AVERAGE
 * coordinate of its active, geocoded partners, the count, and the most common
 * spelling as the display label.
 *
 * Column names are kept in the RPC's snake_case (`lat`/`lon`/`cnt`) so
 * lib/partners/find-nearby-cities.ts maps the response with the identical
 * code path in both implementations.
 *
 * Historical note this replaces: the Supabase build originally selected every
 * active partner's coordinates and grouped in JS, and PostgREST silently
 * capped that at 1,000 rows — 334 of 648 cities, wrong centroids, cached for
 * 24 h (CLAUDE.md §10.9). Reading a materialized 648-row table has no such
 * cliff, and `CITY_SCAN_LIMIT` is explicit rather than implicit.
 */
export const cityCentroids = query({
  args: {},
  returns: v.array(
    v.object({
      city: v.string(),
      lat: v.number(),
      lon: v.number(),
      cnt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("cityCentroids").take(CITY_SCAN_LIMIT);
    return rows.map((r) => ({ city: r.city, lat: r.lat, lon: r.lon, cnt: r.cnt }));
  },
});

/**
 * Backs `npm run generate:coverage`. Port of:
 *
 *   select trim(city) as city, count(*)
 *   from public.partners
 *   where is_active and city is not null and trim(city) <> ''
 *   group by trim(city)
 *
 * NOT on the request path — this runs at build time to regenerate
 * agent/instructions/002-city-coverage.md, which is baked into the system
 * prompt. Counting every active partner (not just geocoded ones) is
 * deliberate; see the `cityCoverage` comment in schema.ts.
 */
export const cityCoverage = query({
  args: {},
  returns: v.array(v.object({ city: v.string(), count: v.number() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("cityCoverage").take(CITY_SCAN_LIMIT);
    return rows.map((r) => ({ city: r.city, count: r.count }));
  },
});
