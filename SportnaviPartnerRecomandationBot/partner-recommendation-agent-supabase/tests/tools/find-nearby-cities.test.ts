import { describe, expect, it } from "vitest";
import {
  findNearbyCities,
  haversineKm,
  normalizeCityKey,
} from "../../lib/partners/find-nearby-cities";
import { createTtlCache } from "../../lib/cache";
import { fakeSupabase } from "./_fakes";

const BOCHUM = { lat: 51.4818, lng: 7.2162 };
const DORTMUND = { lat: 51.5136, lng: 7.4653 };

const home = {
  input: "Bochum",
  canonical: "Bochum",
  aliases: ["Bochum"],
  centroid: BOCHUM,
  partnerCount: 10,
  confidence: 1,
};

/**
 * Rows as returned by `cities:cityCentroids`: already grouped per city,
 * with the centroid averaged and the partner count aggregated server-side.
 *
 * This used to be a list of raw `partners` rows that findNearbyCities grouped
 * in JS. That path selected every active partner through PostgREST, which
 * silently capped the response at 1,000 rows — hiding 314 of 648 cities and
 * averaging the survivors' centroids over a partial row set. Grouping now
 * happens in SQL, so these fixtures describe the aggregate, and the
 * spelling-variant collapse (E21) is asserted against slugifyTag in the
 * backend rather than here.
 *
 * CONVEX PORT: the aggregate now lives in the materialized `cityCentroids`
 * table (convex/migrations.ts:rebuildCityAggregates) instead of a SQL RPC.
 * The column names and the caller's contract are identical, so these fixtures
 * and every assertion below are unchanged apart from the client type.
 */
const centroidRows = [
  { city: "Bochum", lat: BOCHUM.lat, lon: BOCHUM.lng, cnt: 1 },
  { city: "Dortmund", lat: DORTMUND.lat, lon: DORTMUND.lng, cnt: 2 },
  { city: "Essen", lat: 51.4556, lon: 7.0116, cnt: 1 },
];

/** `lat`/`lon` are typed nullable here ONLY so the defense-in-depth test below
 *  can feed a malformed row. The real query never returns one — the
 *  `cityCentroids` table cannot hold null coordinates. */
const centroidsOk = (
  rows: Array<{ city: string; lat: number | null; lon: number | null; cnt: number }>,
) => ({
  cityCentroids: rows as Array<{ city: string; lat: number; lon: number; cnt: number }>,
});

describe("haversineKm", () => {
  it("Bochum ↔ Dortmund is roughly 15-25 km", () => {
    const d = haversineKm(BOCHUM, DORTMUND);
    expect(d).toBeGreaterThan(15);
    expect(d).toBeLessThan(25);
  });

  it("distance to self is 0", () => {
    expect(haversineKm(BOCHUM, BOCHUM)).toBeCloseTo(0, 6);
  });
});

describe("normalizeCityKey", () => {
  it("collapses umlaut spelling variants", () => {
    expect(normalizeCityKey("Köln")).toBe(normalizeCityKey("Koeln"));
  });
});

describe("findNearbyCities", () => {
  it("returns [] when the home city has no centroid (E17)", async () => {
    const supabase = fakeSupabase({});
    const out = await findNearbyCities(
      { home: { ...home, centroid: null }, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out).toEqual([]);
    expect(supabase.calls).toHaveLength(0);
  });

  it("aggregates via the city_centroids RPC, never an unbounded partners scan", async () => {
    // REGRESSION: the previous implementation ran
    // `.from("partners").select("city, latitude, longitude")` with no range,
    // and PostgREST silently truncated it at 1,000 rows — leaving 314 of 648
    // cities permanently unreachable by gap-fill. Aggregating in SQL has no
    // row cap; selecting the table again would reintroduce one.
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(supabase.calls.map((c) => c.fn)).toEqual(["cityCentroids"]);
  });

  it("excludes the home city, sorts nearest-first, and carries the per-city count", async () => {
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    // Essen (~14.5km) is nearer to Bochum than Dortmund (~17.6km) — both fall
    // in the 15-25km sanity band asserted directly against haversineKm above.
    expect(out.map((c) => c.city)).toEqual(["Essen", "Dortmund"]);
    expect(out[0].availableCount).toBe(1);
    expect(out[1].availableCount).toBe(2);
  });

  it("respects maxDistanceKm", async () => {
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: 5 },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out).toEqual([]);
  });

  it("respects limit", async () => {
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    const out = await findNearbyCities(
      { home, limit: 1, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe("Essen");
  });

  it("skips malformed rows instead of producing NaN centroids", async () => {
    const withNulls = [...centroidRows, { city: "Wesel", lat: null, lon: null, cnt: 4 }];
    const supabase = fakeSupabase(centroidsOk(withNulls));
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out.find((c) => c.city === "Wesel")).toBeUndefined();
    expect(out.every((c) => Number.isFinite(c.centroid.lat))).toBe(true);
  });

  it("caches the centroid computation: a second call does not re-query", async () => {
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    const cache = createTtlCache<any>(60);
    await findNearbyCities({ home, limit: 5, maxDistanceKm: null }, { supabase, cache });
    await findNearbyCities({ home, limit: 5, maxDistanceKm: null }, { supabase, cache });
    expect(supabase.callsTo("cityCentroids")).toHaveLength(1);
  });

  it("applies a supplied AbortSignal to the cityCentroids call", async () => {
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    const controller = new AbortController();
    await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60), signal: controller.signal },
    );
    const calls = supabase.callsTo("cityCentroids");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("passes no signal on a cache hit — there's no I/O to bound", async () => {
    const supabase = fakeSupabase(centroidsOk(centroidRows));
    const cache = createTtlCache<any>(60);
    const controller = new AbortController();
    await findNearbyCities({ home, limit: 5, maxDistanceKm: null }, { supabase, cache });
    await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache, signal: controller.signal },
    );
    expect(supabase.callsTo("cityCentroids")).toHaveLength(1); // second call was a cache hit
    expect(supabase.callsTo("cityCentroids")[0]!.signal).toBeUndefined();
  });

  it("breaks distance ties by availableCount desc, then city name asc (E16)", async () => {
    // Essen and Wesel both placed at exactly the same centroid as each other
    // (and thus the same distance from Bochum), so distance alone cannot
    // order them — availableCount desc must win, then name asc.
    const SAME_SPOT = { lat: 51.4, lon: 7.1 };
    const tied = [
      { city: "Bochum", lat: BOCHUM.lat, lon: BOCHUM.lng, cnt: 1 },
      { city: "Wesel", ...SAME_SPOT, cnt: 1 },
      { city: "Essen", ...SAME_SPOT, cnt: 2 },
    ];
    const supabase = fakeSupabase(centroidsOk(tied));
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out.map((c) => c.city)).toEqual(["Essen", "Wesel"]); // Essen: count 2 > Wesel: count 1
  });

  it("breaks a full tie (same distance AND same availableCount) by city name asc (E16)", async () => {
    const SAME_SPOT = { lat: 51.4, lon: 7.1 };
    const tied = [
      { city: "Bochum", lat: BOCHUM.lat, lon: BOCHUM.lng, cnt: 1 },
      { city: "Wesel", ...SAME_SPOT, cnt: 1 },
      { city: "Ahlen", ...SAME_SPOT, cnt: 1 },
    ];
    const supabase = fakeSupabase(centroidsOk(tied));
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out.map((c) => c.city)).toEqual(["Ahlen", "Wesel"]); // same distance, same count(1) → name asc
  });

  it("consumes the backend's collapsed spelling-variant node as one city (E21)", async () => {
    // The collapse itself happens at rebuild time (grouping by slugifyTag(city)),
    // which picks the most common spelling as the label and sums the count.
    // What this asserts is the caller's half of the contract: one node in →
    // one city out, count preserved, no re-splitting by spelling.
    const collapsed = [
      { city: "Bochum", lat: BOCHUM.lat, lon: BOCHUM.lng, cnt: 1 },
      { city: "Köln", lat: 50.91, lon: 6.95, cnt: 3 }, // Köln + Koeln + KÖLN, already merged
    ];
    const supabase = fakeSupabase(centroidsOk(collapsed));
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    const koelnNodes = out.filter((c) => normalizeCityKey(c.city) === normalizeCityKey("Köln"));
    expect(koelnNodes).toHaveLength(1);
    expect(koelnNodes[0].availableCount).toBe(3);
  });

  it("still excludes the home city when the backend labels it with a variant spelling (E21)", async () => {
    // normalizeCityKey remains in use for home/alias exclusion, which happens
    // client-side against whatever label the backend chose.
    const supabase = fakeSupabase(
      centroidsOk([
        { city: "BOCHUM", lat: BOCHUM.lat, lon: BOCHUM.lng, cnt: 5 },
        { city: "Essen", lat: 51.4556, lon: 7.0116, cnt: 1 },
      ]),
    );
    const out = await findNearbyCities(
      { home, limit: 5, maxDistanceKm: null },
      { supabase, cache: createTtlCache(60) },
    );
    expect(out.map((c) => c.city)).toEqual(["Essen"]);
  });
});
