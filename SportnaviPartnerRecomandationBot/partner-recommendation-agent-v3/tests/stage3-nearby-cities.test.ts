import { beforeEach, describe, expect, it } from "vitest";
import { nearbyCities } from "../workflow/stages/3-nearby-cities";
import { clearNearbyCityCache } from "../lib/reused/nearby-cities";
import { ctx } from "./_fakes";

const DORTMUND = { canonical: "Dortmund", centroid: { lat: 51.5136, lng: 7.4653 }, confidence: 1 };

describe("stage 3 — nearby cities", () => {
  beforeEach(() => clearNearbyCityCache());

  it("lists the target first at 0 km, then nearby by distance inside the radius", async () => {
    const r = await nearbyCities({ target: DORTMUND }, ctx({ searchRadiusKm: 30, maxNearbyCities: 5, maxNearbyHubs: 0 }));
    const names = r.output.cities.map((c) => c.city);
    expect(names[0]).toBe("Dortmund");
    expect(r.output.cities[0]).toMatchObject({ role: "target", distanceKm: 0, partnerCount: 20 });
    expect(names).toEqual(["Dortmund", "Castrop-Rauxel", "Lünen", "Hagen", "Bochum"]); // Essen ~32 km is outside 30 km
    for (let i = 2; i < r.output.cities.length; i++) expect(r.output.cities[i]!.distanceKm).toBeGreaterThanOrEqual(r.output.cities[i - 1]!.distanceKm);
  });

  it("respects maxNearbyCities and adds hubs", async () => {
    const two = await nearbyCities({ target: DORTMUND }, ctx({ searchRadiusKm: 60, maxNearbyCities: 2, maxNearbyHubs: 0 }));
    expect(two.output.cities.map((c) => c.city)).toEqual(["Dortmund", "Castrop-Rauxel", "Lünen"]);
    const hub = await nearbyCities({ target: DORTMUND }, ctx({ searchRadiusKm: 60, maxNearbyCities: 2, maxNearbyHubs: 1 }));
    expect(hub.output.cities.map((c) => c.city)).toContain("Bochum");
  });

  it("omits the target when includeTargetCity is false", async () => {
    const r = await nearbyCities({ target: DORTMUND }, ctx({ includeTargetCity: false, maxNearbyHubs: 0 }));
    expect(r.output.cities.every((c) => c.role === "nearby")).toBe(true);
  });

  it("records counts and config", async () => {
    const r = await nearbyCities({ target: DORTMUND }, ctx({ maxNearbyHubs: 0 }));
    expect(r.counts).toEqual({ withinRadius: 4, nearbyChosen: 4, citiesToSearch: 5 });
    expect(r.config).toEqual({ searchRadiusKm: 30, maxNearbyCities: 5, maxNearbyHubs: 0, includeTargetCity: true });
  });
});
