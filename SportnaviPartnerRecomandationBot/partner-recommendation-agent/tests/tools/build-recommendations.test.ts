import { describe, expect, it, vi } from "vitest";
import { buildRecommendations } from "../../lib/partners/build-recommendations";
import { fakeSupabase } from "./_fakes";
import type { PartnerLite, ResolvedCity, ResolvedPartnerSet, ResolutionMeta } from "../../lib/partners/types";

const CITY: ResolvedCity = {
  input: "Bochum",
  canonical: "Bochum",
  aliases: ["Bochum"],
  centroid: { lat: 51.48, lng: 7.22 },
  partnerCount: 10,
  confidence: 1,
};

function lite(id: number, overrides: Partial<PartnerLite> = {}): PartnerLite {
  return {
    id,
    name: `Partner ${id}`,
    city: "Bochum",
    tags: [],
    summary: `summary ${id}`,
    website_url: null,
    source: "home",
    sourceCity: "Bochum",
    ...overrides,
  };
}

function meta(overrides: Partial<ResolutionMeta> = {}): ResolutionMeta {
  return {
    minRequired: 5,
    maxAllowed: 40,
    maxCities: 4,
    totalReturned: 0,
    minMet: true,
    cappedAtMax: false,
    citiesExhausted: false,
    warnings: [],
    timingsMs: {},
    ...overrides,
  };
}

function setOf(
  home: PartnerLite[],
  filled: PartnerLite[],
  citiesUsed: string[],
  metaOverrides: Partial<ResolutionMeta> = {},
): ResolvedPartnerSet {
  return {
    requestedCity: CITY,
    home,
    filled,
    citiesUsed,
    meta: meta({ totalReturned: home.length + filled.length, ...metaOverrides }),
  };
}

function fakeProfiles(ids: number[]) {
  return vi.fn(async (queriedIds: number[]) => {
    const map = new Map<number, { name: string; city: string | null; llmProfile: string }>();
    for (const id of queriedIds) {
      if (ids.includes(id)) {
        map.set(id, { name: `Hydrated ${id}`, city: "Bochum", llmProfile: `## Profile ${id}` });
      }
    }
    return map;
  });
}

describe("buildRecommendations — boundary test", () => {
  it("7) available < finalRecommendations → return all available (E11)", async () => {
    const home = [lite(1), lite(2)];
    const set = setOf(home, [], ["Bochum"]);
    const getPartnerProfiles = fakeProfiles([1, 2]);

    const { recommendations } = await buildRecommendations(
      { set, finalRecommendations: 5 },
      { getPartnerProfiles },
    );

    expect(recommendations).toHaveLength(2); // never invents a 3rd/4th/5th
    expect(recommendations.map((r) => r.partnerId)).toEqual([1, 2]);
  });
});

describe("buildRecommendations — ranking order", () => {
  it("home first (stable order), then filled by similarity desc, tiebreak distanceKm asc, then id asc", async () => {
    const home = [lite(2), lite(1)]; // insertion order preserved, no re-sort
    const filled = [
      lite(10, { source: "nearby", sourceCity: "Dortmund", similarity: 0.6, distanceKm: 20 }),
      lite(11, { source: "nearby", sourceCity: "Dortmund", similarity: 0.9, distanceKm: 15 }),
      lite(12, { source: "nearby", sourceCity: "Dortmund", similarity: 0.6, distanceKm: 5 }), // ties 10 on similarity, wins on distance
      lite(13, { source: "nearby", sourceCity: "Essen", similarity: 0.9, distanceKm: 15 }), // ties 11 fully — id asc breaks it
    ];
    const set = setOf(home, filled, ["Bochum", "Dortmund", "Essen"]);
    const getPartnerProfiles = fakeProfiles([2, 1, 10, 11, 12, 13]);

    const { recommendations } = await buildRecommendations(
      { set, finalRecommendations: 10 },
      { getPartnerProfiles },
    );

    expect(recommendations.map((r) => r.partnerId)).toEqual([2, 1, 11, 13, 12, 10]);
  });
});

describe("buildRecommendations — one-batch hydration", () => {
  it("calls getPartnerProfiles exactly once with all chosen ids batched", async () => {
    const home = [lite(1), lite(2), lite(3)];
    const set = setOf(home, [], ["Bochum"]);
    const getPartnerProfiles = fakeProfiles([1, 2, 3]);

    await buildRecommendations({ set, finalRecommendations: 3 }, { getPartnerProfiles });

    expect(getPartnerProfiles).toHaveBeenCalledTimes(1);
    expect(getPartnerProfiles).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("does not call getPartnerProfiles when nothing is chosen", async () => {
    const set = setOf([], [], [], { minMet: false });
    const getPartnerProfiles = fakeProfiles([]);

    const { recommendations } = await buildRecommendations(
      { set, finalRecommendations: 5 },
      { getPartnerProfiles },
    );

    expect(recommendations).toEqual([]);
    expect(getPartnerProfiles).not.toHaveBeenCalled();
  });

  it("hydrates llmProfile/name/city from the batch result, overriding the lite fallback", async () => {
    const home = [lite(1, { name: "Fallback Name", summary: "fallback summary" })];
    const set = setOf(home, [], ["Bochum"]);
    const getPartnerProfiles = fakeProfiles([1]);

    const { recommendations } = await buildRecommendations(
      { set, finalRecommendations: 1 },
      { getPartnerProfiles },
    );

    expect(recommendations[0].name).toBe("Hydrated 1");
    expect(recommendations[0].llmProfile).toBe("## Profile 1");
  });

  it("falls back to the lite summary as llmProfile when hydration fails, and adds a warning", async () => {
    const home = [lite(1, { summary: "fallback summary" })];
    const set = setOf(home, [], ["Bochum"]);
    const getPartnerProfiles = vi.fn(async () => {
      throw new Error("rpc down");
    });

    const { recommendations, warnings } = await buildRecommendations(
      { set, finalRecommendations: 1 },
      { getPartnerProfiles },
    );

    expect(recommendations[0].llmProfile).toBe("fallback summary");
    expect(warnings.some((w) => /hydration failed/i.test(w))).toBe(true);
  });
});

describe("buildRecommendations — default hydration timeout wiring", () => {
  it("applies a supplied AbortSignal to the default get_partner_profiles RPC call", async () => {
    const home = [lite(1)];
    const set = setOf(home, [], ["Bochum"]);
    const supabase = fakeSupabase({
      rpc: {
        get_partner_profiles: {
          data: [{ partner_id: 1, title: "Hydrated 1", city: "Bochum", llm_profile: "## Profile 1" }],
          error: null,
        },
      },
    });
    const controller = new AbortController();

    await buildRecommendations(
      { set, finalRecommendations: 1 },
      { supabase, signal: controller.signal },
    );

    const abortCalls = supabase.methodCalls.filter((c: any) => c.method === "abortSignal");
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].args[0]).toBe(controller.signal);
  });
});

describe("buildRecommendations — disclosure", () => {
  it("home only: no borrowing mentioned", async () => {
    const set = setOf([lite(1), lite(2)], [], ["Bochum"]);
    const { disclosure } = await buildRecommendations(
      { set, finalRecommendations: 2 },
      { getPartnerProfiles: fakeProfiles([1, 2]) },
    );
    expect(disclosure).toBe("Partners: 2 in Bochum.");
  });

  it("home + nearby: discloses borrowed cities and count with rough distance", async () => {
    const home = [lite(1), lite(2)];
    const filled = [
      lite(10, { source: "nearby", sourceCity: "Dortmund", similarity: 0.8, distanceKm: 15 }),
      lite(11, { source: "nearby", sourceCity: "Heidenheim", similarity: 0.6, distanceKm: 30 }),
    ];
    const set = setOf(home, filled, ["Bochum", "Dortmund", "Heidenheim"]);
    const { disclosure } = await buildRecommendations(
      { set, finalRecommendations: 4 },
      { getPartnerProfiles: fakeProfiles([1, 2, 10, 11]) },
    );
    expect(disclosure).toBe("Partners: 2 in Bochum; 2 nearby from Dortmund, Heidenheim (~15 km).");
  });

  it("shortfall: appends an honest coverage-limited note derived from meta, never inventing numbers", async () => {
    const home = [lite(1)];
    const set = setOf(home, [], ["Bochum"], { minMet: false, minRequired: 12 });
    const { disclosure } = await buildRecommendations(
      { set, finalRecommendations: 5 },
      { getPartnerProfiles: fakeProfiles([1]) },
    );
    expect(disclosure).toContain("Partners: 1 in Bochum.");
    expect(disclosure).toContain("Coverage near Bochum is limited");
    expect(disclosure).toContain("showing the best 1 found");
  });

  it("no coverage: aliases empty produces the honest no-partners line", async () => {
    const noCoverageCity: ResolvedCity = { ...CITY, aliases: [] };
    const set: ResolvedPartnerSet = {
      requestedCity: noCoverageCity,
      home: [],
      filled: [],
      citiesUsed: [],
      meta: meta({ minMet: false, citiesExhausted: true }),
    };
    const { disclosure } = await buildRecommendations(
      { set, finalRecommendations: 5 },
      { getPartnerProfiles: fakeProfiles([]) },
    );
    expect(disclosure).toBe('No partners are listed for "Bochum".');
  });
});

/**
 * Regression suite for the hydration/disclosure defects found in the
 * 2026-08-01 production-readiness review. All three were silent: a successful
 * RPC that returned fewer rows than asked for, a fallback that produced an
 * empty profile only for borrowed partners, and a disclosure computed from the
 * resolved set rather than the shortlist actually shown.
 */
describe("buildRecommendations — hydration and disclosure integrity", () => {
  const nearby = (id: number, city = "Dortmund") =>
    lite(id, {
      source: "nearby",
      city,
      sourceCity: city,
      similarity: 0.5,
      distanceKm: 15,
      // match_partners does not return body_markdown, so nearby partners have
      // no summary to fall back on — this is what made C1 produce blanks.
      summary: "",
    });

  it("warns when hydration returns fewer profiles than requested", async () => {
    // `get_partner_profiles` carried a hardcoded `limit 10`, so a 12-id
    // request returned 10 rows with a success status and no warning.
    const home = [1, 2, 3].map((id) => lite(id));
    const { warnings } = await buildRecommendations(
      { set: setOf(home, [], ["Bochum"]), finalRecommendations: 5 },
      { getPartnerProfiles: fakeProfiles([1, 2]) }, // 3 asked, 2 returned
    );
    expect(warnings.some((w) => /hydration returned 2 of 3/i.test(w))).toBe(true);
  });

  it("omits partners with no profile content rather than handing the model a bare name", async () => {
    // A name + city with no profile text, given to a model instructed to cite
    // "a concrete, specific detail", is the CLAUDE.md §11 fabrication setup.
    const home = [lite(1)];
    const borrowed = [nearby(2), nearby(3)];
    const { recommendations, warnings } = await buildRecommendations(
      { set: setOf(home, borrowed, ["Bochum", "Dortmund"]), finalRecommendations: 5 },
      { getPartnerProfiles: fakeProfiles([1]) }, // only the home partner hydrates
    );
    expect(recommendations.map((r) => r.partnerId)).toEqual([1]);
    expect(warnings.some((w) => /2 partner\(s\) omitted for missing profile content/i.test(w))).toBe(
      true,
    );
  });

  it("keeps a home partner whose hydration failed but whose summary is real text", async () => {
    // The `?? c.summary` fallback is still correct for home partners: their
    // summary is the cleaned body_markdown, which is real grounded data.
    const { recommendations } = await buildRecommendations(
      { set: setOf([lite(1)], [], ["Bochum"]), finalRecommendations: 5 },
      { getPartnerProfiles: fakeProfiles([]) },
    );
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].llmProfile).toBe("summary 1");
  });

  it("never claims borrowed partners that the shortlist does not contain", async () => {
    // finalRecommendations is a model-controlled argument and home partners
    // fill the shortlist first, so a narrow request could produce an all-home
    // list under a disclosure advertising partners from Dortmund.
    const home = [1, 2, 3].map((id) => lite(id));
    const borrowed = [nearby(4), nearby(5)];
    const { recommendations, disclosure } = await buildRecommendations(
      { set: setOf(home, borrowed, ["Bochum", "Dortmund"]), finalRecommendations: 2 },
      { getPartnerProfiles: fakeProfiles([1, 2, 3, 4, 5]) },
    );
    expect(recommendations.map((r) => r.partnerId)).toEqual([1, 2]);
    expect(disclosure).toContain("2 in Bochum");
    expect(disclosure).not.toContain("Dortmund");
    expect(disclosure).not.toContain("nearby");
  });

  it("discloses that the list is not exhaustive when the working set was larger", async () => {
    const home = [1, 2, 3, 4].map((id) => lite(id));
    const { disclosure } = await buildRecommendations(
      { set: setOf(home, [], ["Bochum"]), finalRecommendations: 2 },
      { getPartnerProfiles: fakeProfiles([1, 2, 3, 4]) },
    );
    expect(disclosure).toContain("Showing 2 of 4 found");
  });

  it("counts borrowed cities from the shortlist, not from citiesUsed", async () => {
    const borrowed = [nearby(2, "Dortmund"), nearby(3, "Essen")];
    const { disclosure } = await buildRecommendations(
      { set: setOf([lite(1)], borrowed, ["Bochum", "Dortmund", "Essen"]), finalRecommendations: 2 },
      { getPartnerProfiles: fakeProfiles([1, 2, 3]) },
    );
    // Only partner 2 (Dortmund) makes the cut — Essen must not be advertised.
    expect(disclosure).toContain("Dortmund");
    expect(disclosure).not.toContain("Essen");
  });
});
