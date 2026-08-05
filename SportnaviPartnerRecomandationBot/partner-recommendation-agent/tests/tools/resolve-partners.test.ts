import { describe, expect, it, vi } from "vitest";
import { resolvePartners, overflowTrim, stableHash } from "../../lib/partners/resolve-partners";
import type { PartnerRow, PartnerLite, ResolvedCity, Intent, NearbyCity, SimilarityHit } from "../../lib/partners/types";
import { DEFAULT_CONFIG, type PartnerInjectionConfig } from "../../agent/config/partner-injection.config";

// ── Fixtures ──────────────────────────────────────────────────────────────

const CITY: ResolvedCity = {
  input: "Bochum",
  canonical: "Bochum",
  aliases: ["Bochum"],
  centroid: { lat: 51.4818, lng: 7.2162 },
  partnerCount: 10,
  confidence: 1,
};

const INTENT: Intent = { text: "Krafttraining", tags: [] };

function row(id: number, overrides: Partial<PartnerRow> = {}): PartnerRow {
  return {
    id,
    name: `Partner ${id}`,
    city: "Bochum",
    postal_code: null,
    latitude: 51.48,
    longitude: 7.21,
    tags_norm: [],
    courses_text: null,
    body_markdown: `# Profile ${id}\nSome **markdown** body.`,
    website_url: null,
    is_active: true,
    quality_score: null,
    updated_at: null,
    ...overrides,
  };
}

function hit(id: number, similarity: number, overrides: Partial<SimilarityHit> = {}): SimilarityHit {
  return {
    id,
    name: `Nearby ${id}`,
    city: "Dortmund",
    tags_norm: [],
    body_markdown: `Nearby body ${id}`,
    website_url: null,
    similarity,
    ...overrides,
  };
}

function neighbor(city: string, distanceKm: number, availableCount = 5): NearbyCity {
  return { city, centroid: { lat: 51.5, lng: 7.4 }, distanceKm, availableCount };
}

/** Builds mocked leaf deps. Each mock is a plain async function (vi.fn-wrapped). */
function makeDeps(opts: {
  homeRows?: PartnerRow[];
  neighbors?: NearbyCity[];
  hitsByCity?: Record<string, SimilarityHit[]>;
  throwForCity?: string[];
  failHome?: boolean;
  failNeighbors?: boolean;
}) {
  const getPartnersByCityFn = vi.fn(async () => {
    if (opts.failHome) throw new Error("db unreachable");
    return opts.homeRows ?? [];
  });
  const findNearbyCitiesFn = vi.fn(async () => {
    if (opts.failNeighbors) throw new Error("centroid lookup timed out");
    return opts.neighbors ?? [];
  });
  const similaritySearchPartnersFn = vi.fn(async (input: { city: string }) => {
    if (opts.throwForCity?.includes(input.city)) {
      throw new Error(`search backend down for ${input.city}`);
    }
    return { hits: opts.hitsByCity?.[input.city] ?? [], warnings: [] };
  });
  return {
    getPartnersByCityFn: getPartnersByCityFn as any,
    findNearbyCitiesFn: findNearbyCitiesFn as any,
    similaritySearchPartnersFn: similaritySearchPartnersFn as any,
    now: () => 0,
  };
}

const baseConfig: Partial<PartnerInjectionConfig> = {
  minPartners: 5,
  maxPartners: 40,
  maxCities: 4,
  similarityThreshold: 0.35,
  dedupHeadroom: 5,
  maxDistanceKm: 60,
};

// ── Boundary tests (pseudocode table) ───────────────────────────────────────

describe("resolvePartners — boundary tests", () => {
  it("1) home == minPartners exactly → no gap-fill (E28)", async () => {
    const homeRows = [1, 2, 3, 4, 5].map((id) => row(id));
    const deps = makeDeps({ homeRows });

    const result = await resolvePartners({ city: CITY, intent: INTENT, config: baseConfig }, deps);

    expect(result.home).toHaveLength(5);
    expect(result.filled).toEqual([]);
    expect(result.citiesUsed).toEqual(["Bochum"]);
    expect(result.meta.minMet).toBe(true);
    expect(deps.findNearbyCitiesFn).not.toHaveBeenCalled();
  });

  it("2) home == minPartners − 1 → gap == 1, borrow exactly 1", async () => {
    const homeRows = [1, 2, 3, 4].map((id) => row(id));
    const deps = makeDeps({
      homeRows,
      neighbors: [neighbor("Dortmund", 15)],
      hitsByCity: { Dortmund: [hit(101, 0.9), hit(102, 0.8), hit(103, 0.7)] },
    });

    const result = await resolvePartners({ city: CITY, intent: INTENT, config: baseConfig }, deps);

    expect(result.home).toHaveLength(4);
    expect(result.filled).toHaveLength(1);
    expect(result.filled[0].id).toBe(101); // best hit accepted first
    expect(result.meta.minMet).toBe(true);
  });

  it("3) maxCities == 1 → loop never runs; home only (E29)", async () => {
    const homeRows = [1, 2, 3].map((id) => row(id));
    const deps = makeDeps({
      homeRows,
      neighbors: [neighbor("Dortmund", 15)],
      hitsByCity: { Dortmund: [hit(101, 0.9)] },
    });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, maxCities: 1 } },
      deps,
    );

    expect(result.filled).toEqual([]);
    expect(result.citiesUsed).toEqual(["Bochum"]);
    expect(deps.similaritySearchPartnersFn).not.toHaveBeenCalled();
    expect(result.meta.minMet).toBe(false); // 3 < 5, and no borrowing was possible
  });

  it("4) all candidates below threshold → filled == [], minMet == false (E9)", async () => {
    const homeRows = [1, 2].map((id) => row(id));
    const deps = makeDeps({
      homeRows,
      neighbors: [neighbor("Dortmund", 15)],
      hitsByCity: { Dortmund: [hit(101, 0.1), hit(102, 0.2)] },
    });

    const result = await resolvePartners({ city: CITY, intent: INTENT, config: baseConfig }, deps);

    expect(result.filled).toEqual([]);
    expect(result.meta.minMet).toBe(false);
    expect(result.meta.warnings.some((w) => /rejected below similarity floor/.test(w))).toBe(true);
  });

  it("5) partner in home AND neighbor results → counted once, source \"home\" (E8)", async () => {
    const homeRows = [1, 2].map((id) => row(id));
    const deps = makeDeps({
      homeRows,
      neighbors: [neighbor("Dortmund", 15)],
      // id 1 also comes back from the nearby search — must be deduped away.
      hitsByCity: { Dortmund: [hit(1, 0.95), hit(101, 0.9), hit(102, 0.8)] },
    });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 5 } },
      deps,
    );

    const allIds = [...result.home, ...result.filled].map((p) => p.id);
    expect(allIds.filter((id) => id === 1)).toHaveLength(1);
    const partnerOne = result.home.find((p) => p.id === 1);
    expect(partnerOne?.source).toBe("home");
    expect(result.filled.some((p) => p.id === 1)).toBe(false);
  });

  it("6) home > maxPartners → overflow_trim to exactly maxPartners (E14)", async () => {
    const homeRows = Array.from({ length: 10 }, (_, i) =>
      row(i + 1, { quality_score: 10 - i }), // id 1 has the highest quality_score
    );
    const deps = makeDeps({ homeRows });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 3, maxPartners: 5 } },
      deps,
    );

    expect(result.home).toHaveLength(5);
    expect(result.home.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]); // highest quality first
    expect(result.filled).toEqual([]);
    expect(result.citiesUsed).toEqual(["Bochum"]);
    expect(result.meta.minMet).toBe(true);
    expect(result.meta.cappedAtMax).toBe(true);
  });

  it("9) zero home partners → all filled partners borrowed from nearby (E7 boundary)", async () => {
    const deps = makeDeps({
      homeRows: [],
      neighbors: [neighbor("Dortmund", 15)],
      hitsByCity: { Dortmund: [hit(101, 0.9), hit(102, 0.8), hit(103, 0.7)] },
    });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 3 } },
      deps,
    );

    expect(result.home).toEqual([]);
    expect(result.filled.map((p) => p.id)).toEqual([101, 102, 103]);
    expect(result.filled.every((p) => p.source === "nearby")).toBe(true);
    expect(result.meta.minMet).toBe(true);
  });

  it("10) no nearby cities in range → loop doesn't run, home-only result (E15)", async () => {
    const deps = makeDeps({
      homeRows: [row(1), row(2)],
      neighbors: [], // isolated city / all beyond maxDistanceKm
    });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 5 } },
      deps,
    );

    expect(result.home).toHaveLength(2);
    expect(result.filled).toEqual([]);
    expect(result.citiesUsed).toEqual(["Bochum"]);
    expect(deps.similaritySearchPartnersFn).not.toHaveBeenCalled();
    expect(result.meta.minMet).toBe(false); // 2 < 5, honestly reported
    expect(result.meta.citiesExhausted).toBe(true);
  });

  /**
   * CONTRACT CHANGE (parallel gap-fill). The nearby-city searches now run
   * CONCURRENTLY, because they target disjoint cities and share no state —
   * serially, one slow city burned its whole timeout before the next started,
   * and thin cities are the worst-latency path in the product.
   *
   * The cost of that: `k` can no longer shrink as the gap closes, because no
   * search has finished when the others are dispatched. Every city is sized
   * from the INITIAL gap, so we may fetch a few surplus candidates. They are
   * discarded by the same gap/dedupe/floor filters as before, and `k` is still
   * demand-driven (bounded by minPartners + dedupHeadroom) rather than fixed —
   * so E26's intent, "never fetch an unbounded page", holds. What changed is
   * only the per-city shrinking.
   */
  it("11) k passed to similaritySearchPartnersFn is initialGap + dedupHeadroom for every city (parallel gap-fill)", async () => {
    const deps = makeDeps({
      homeRows: [row(1)], // gap = 5 - 1 = 4 initially
      neighbors: [neighbor("Dortmund", 15), neighbor("Essen", 25)],
      hitsByCity: {
        Dortmund: [hit(101, 0.9), hit(102, 0.8)], // fills 2, gap becomes 2
        Essen: [hit(201, 0.9)],
      },
    });

    await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 5, dedupHeadroom: 3 } },
      deps,
    );

    const calls = deps.similaritySearchPartnersFn.mock.calls as Array<[{ city: string; k: number }]>;
    const dortmundCall = calls.find(([input]) => input.city === "Dortmund");
    const essenCall = calls.find(([input]) => input.city === "Essen");
    expect(dortmundCall?.[0].k).toBe(4 + 3); // initialGap(4) + dedupHeadroom(3)
    expect(essenCall?.[0].k).toBe(4 + 3); // same — dispatched before Dortmund returned
  });

  it("11b) parallel gap-fill still yields the nearest-first selection (deterministic)", async () => {
    const deps = makeDeps({
      homeRows: [row(1)],
      neighbors: [neighbor("Dortmund", 15), neighbor("Essen", 25)],
      hitsByCity: {
        Dortmund: [hit(101, 0.9), hit(102, 0.8)],
        Essen: [hit(201, 0.95)], // higher similarity, but FARTHER away
      },
    });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 5, dedupHeadroom: 3 } },
      deps,
    );

    // Results are consumed in nearest-first order regardless of which query
    // resolved first, so the closer city's partners still lead — Essen's
    // stronger similarity must not reorder the set just because it raced ahead.
    expect(result.filled.map((p) => p.sourceCity)).toEqual(["Dortmund", "Dortmund", "Essen"]);
  });

  it("8) config min > max → clamp + warning (E10)", async () => {
    const homeRows = [1, 2].map((id) => row(id));
    const deps = makeDeps({ homeRows });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 50, maxPartners: 10 } },
      deps,
    );

    expect(result.meta.minRequired).toBe(10); // clamped to maxPartners
    expect(result.meta.warnings.some((w) => /clamp/i.test(w))).toBe(true);
  });
});

// ── Resilience: per-city failure never takes down the whole search ─────────

describe("resolvePartners — per-city resilience", () => {
  it("skips a failing nearby city with a warning, still uses the next one (E24)", async () => {
    const homeRows = [1].map((id) => row(id));
    const deps = makeDeps({
      homeRows,
      neighbors: [neighbor("Essen", 10), neighbor("Dortmund", 20)],
      hitsByCity: { Dortmund: [hit(201, 0.9), hit(202, 0.8)] },
      throwForCity: ["Essen"],
    });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 3 } },
      deps,
    );

    expect(result.meta.warnings.some((w) => /Essen/.test(w) && /skipped/.test(w))).toBe(true);
    expect(result.filled.map((p) => p.id)).toEqual([201, 202]);
    expect(result.citiesUsed).toEqual(["Bochum", "Dortmund"]);
  });

  it("throws when the home fetch itself fails (hard error — home is never skipped)", async () => {
    const deps = makeDeps({ failHome: true });
    await expect(
      resolvePartners({ city: CITY, intent: INTENT, config: baseConfig }, deps),
    ).rejects.toThrow(/db unreachable/);
  });

  it("degrades to a home-only result when findNearbyCities itself fails — never a stack trace", async () => {
    const homeRows = [1, 2].map((id) => row(id));
    const deps = makeDeps({ homeRows, failNeighbors: true });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 5 } },
      deps,
    );

    expect(result.home).toHaveLength(2); // home is intact, never discarded
    expect(result.filled).toEqual([]);
    expect(result.citiesUsed).toEqual(["Bochum"]);
    expect(deps.similaritySearchPartnersFn).not.toHaveBeenCalled();
    expect(
      result.meta.warnings.some((w) => /nearby-city lookup failed/i.test(w) && /home-only/i.test(w)),
    ).toBe(true);
    expect(result.meta.minMet).toBe(false); // 2 < 5, honestly reported
    expect(result.meta.citiesExhausted).toBe(true);
  });

  it("home-only degrade still reports minMet=true when home alone already satisfied minPartners... but that path never reaches findNearbyCities (Step 3 short-circuits)", async () => {
    // Sanity check the invariant the fix relies on: Step 4 (and thus the
    // findNearbyCities call) is only ever reached when home < minPartners,
    // so the degrade path's minMet is always computed honestly from a
    // genuine shortfall, never silently masking a satisfied minimum.
    const homeRows = [1, 2, 3, 4, 5].map((id) => row(id));
    const deps = makeDeps({ homeRows, failNeighbors: true });

    const result = await resolvePartners(
      { city: CITY, intent: INTENT, config: { ...baseConfig, minPartners: 5 } },
      deps,
    );

    expect(deps.findNearbyCitiesFn).not.toHaveBeenCalled();
    expect(result.meta.minMet).toBe(true);
  });
});

// ── Invariants (property-style over several scenarios) ──────────────────────

describe("resolvePartners — invariants", () => {
  const scenarios: Array<{
    name: string;
    homeRows: PartnerRow[];
    neighbors: NearbyCity[];
    hitsByCity: Record<string, SimilarityHit[]>;
    config: Partial<PartnerInjectionConfig>;
  }> = [
    {
      name: "small home, one neighbor, plenty of candidates",
      homeRows: [row(1), row(2)],
      neighbors: [neighbor("Dortmund", 15), neighbor("Essen", 25)],
      hitsByCity: {
        Dortmund: [hit(101, 0.9), hit(102, 0.8), hit(103, 0.2)],
        Essen: [hit(201, 0.7), hit(202, 0.1)],
      },
      config: { minPartners: 6, maxPartners: 40, maxCities: 4 },
    },
    {
      name: "oversized home, no borrowing needed",
      homeRows: Array.from({ length: 20 }, (_, i) => row(i + 1, { quality_score: i })),
      neighbors: [],
      hitsByCity: {},
      config: { minPartners: 3, maxPartners: 8, maxCities: 4 },
    },
    {
      name: "many neighbors, tight city budget",
      homeRows: [row(1)],
      neighbors: [neighbor("A", 5), neighbor("B", 10), neighbor("C", 15), neighbor("D", 20)],
      hitsByCity: {
        A: [hit(301, 0.9)],
        B: [hit(302, 0.9)],
        C: [hit(303, 0.9)],
        D: [hit(304, 0.9)],
      },
      config: { minPartners: 10, maxPartners: 40, maxCities: 3 },
    },
    {
      name: "shortfall — never enough supply",
      homeRows: [row(1)],
      neighbors: [neighbor("Dortmund", 15)],
      hitsByCity: { Dortmund: [hit(101, 0.9)] },
      config: { minPartners: 20, maxPartners: 40, maxCities: 4 },
    },
  ];

  for (const s of scenarios) {
    it(`holds for: ${s.name}`, async () => {
      const cfg: Partial<PartnerInjectionConfig> = {
        ...baseConfig,
        ...s.config,
      };
      const deps = makeDeps({ homeRows: s.homeRows, neighbors: s.neighbors, hitsByCity: s.hitsByCity });
      const result = await resolvePartners({ city: CITY, intent: INTENT, config: cfg }, deps);

      const merged = { ...DEFAULT_CONFIG, ...cfg };

      // 1) home-source purity
      expect(result.home.every((p) => p.source === "home")).toBe(true);
      // 2) filled <= original gap (home never exceeds minPartners at this point unless overflow-trimmed)
      const gap = Math.max(0, merged.minPartners - s.homeRows.length);
      expect(result.filled.length).toBeLessThanOrEqual(gap);
      // 3) no duplicate ids
      const ids = [...result.home, ...result.filled].map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      // 4) citiesUsed <= maxCities
      expect(result.citiesUsed.length).toBeLessThanOrEqual(merged.maxCities);
      // 5) total <= maxPartners
      expect(result.home.length + result.filled.length).toBeLessThanOrEqual(merged.maxPartners);
      // 6) every filled partner: similarity >= threshold, distance <= cap (when set)
      for (const p of result.filled) {
        expect(p.similarity ?? 0).toBeGreaterThanOrEqual(merged.similarityThreshold);
        if (merged.maxDistanceKm !== null) {
          expect(p.distanceKm ?? 0).toBeLessThanOrEqual(merged.maxDistanceKm);
        }
      }

      // 7) identical inputs produce identical outputs
      const deps2 = makeDeps({ homeRows: s.homeRows, neighbors: s.neighbors, hitsByCity: s.hitsByCity });
      const result2 = await resolvePartners({ city: CITY, intent: INTENT, config: cfg }, deps2);
      expect(result2).toEqual(result);
    });
  }
});

// ── overflow_trim strategies ─────────────────────────────────────────────

describe("overflowTrim", () => {
  const cfgFor = (overflowStrategy: PartnerInjectionConfig["overflowStrategy"]): PartnerInjectionConfig => ({
    ...DEFAULT_CONFIG,
    maxPartners: 3,
    overflowStrategy,
  });

  it('"quality": sorts by quality_score desc, nulls last, tiebreak id asc', async () => {
    const rows = [
      row(1, { quality_score: 0.5 }),
      row(2, { quality_score: null }),
      row(3, { quality_score: 0.9 }),
      row(4, { quality_score: 0.9 }), // tie with 3 → id asc
      row(5, { quality_score: 0.1 }),
    ];
    const lite: PartnerLite[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      tags: [],
      summary: "",
      website_url: null,
      source: "home",
      sourceCity: "Bochum",
    }));
    const out = await overflowTrim(lite, rows, cfgFor("quality"), {
      intent: INTENT,
      homeCity: "Bochum",
      rankHomeBySimilarity: async () => new Map(),
    });
    expect(out.map((p) => p.id)).toEqual([3, 4, 1]);
  });

  it('"recency": sorts by updated_at desc, nulls last', async () => {
    const rows = [
      row(1, { updated_at: "2026-01-01T00:00:00Z" }),
      row(2, { updated_at: null }),
      row(3, { updated_at: "2026-06-01T00:00:00Z" }),
      row(4, { updated_at: "2026-03-01T00:00:00Z" }),
    ];
    const lite: PartnerLite[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      tags: [],
      summary: "",
      website_url: null,
      source: "home",
      sourceCity: "Bochum",
    }));
    const out = await overflowTrim(lite, rows, cfgFor("recency"), {
      intent: INTENT,
      homeCity: "Bochum",
      rankHomeBySimilarity: async () => new Map(),
    });
    expect(out.map((p) => p.id)).toEqual([3, 4, 1]);
  });

  it('"random-stable": deterministic across repeated calls (no Math.random)', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i + 1));
    const lite: PartnerLite[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      tags: [],
      summary: "",
      website_url: null,
      source: "home",
      sourceCity: "Bochum",
    }));
    const ctx = { intent: INTENT, homeCity: "Bochum", rankHomeBySimilarity: async () => new Map() };
    const out1 = await overflowTrim(lite, rows, cfgFor("random-stable"), ctx);
    const out2 = await overflowTrim(lite, rows, cfgFor("random-stable"), ctx);
    expect(out1.map((p) => p.id)).toEqual(out2.map((p) => p.id));
    expect(out1).toHaveLength(3);
  });

  it("stableHash is a pure deterministic function of id", () => {
    expect(stableHash(42)).toBe(stableHash(42));
    expect(stableHash(1)).not.toBe(stableHash(2));
  });

  it('"similarity-overflow": re-ranks home by relevance via the injected rank fn; unranked ids go last', async () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const lite: PartnerLite[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      tags: [],
      summary: "",
      website_url: null,
      source: "home",
      sourceCity: "Bochum",
    }));
    const rankFn = vi.fn(async () => new Map([[2, 0.9], [1, 0.5]])); // 3 and 4 unranked
    const out = await overflowTrim(lite, rows, cfgFor("similarity-overflow"), {
      intent: INTENT,
      homeCity: "Bochum",
      rankHomeBySimilarity: rankFn,
    });
    // Ranked ids come first, ordered by score desc; unranked ids (3, 4) are
    // ordered deterministically by stableHash (not id) among themselves —
    // only the top `maxPartners` (3) survive the trim.
    expect(out.map((p) => p.id).slice(0, 2)).toEqual([2, 1]);
    expect(out).toHaveLength(3);
    expect([3, 4]).toContain(out[2].id);
    expect(rankFn).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression: the gap-fill fan-out queries every candidate city concurrently
 * with the SAME intent text, but the module-level embedding cache in
 * lib/embeddings.ts is only populated after the first call RESOLVES — so all N
 * concurrent searches missed and issued N identical embedding requests. That
 * is N times the cost, N times the latency exposure, and N chances for the
 * embedding provider to fail a single search.
 */
describe("resolvePartners — embeds once for the whole gap-fill fan-out", () => {
  const nearbyCities: NearbyCity[] = ["Dortmund", "Essen", "Herne", "Witten"].map((city, i) => ({
    city,
    centroid: { lat: 51.5 + i / 100, lng: 7.4 - i / 100 },
    distanceKm: 10 + i,
    availableCount: 5,
  }));

  /** Typed so `.mock.calls` exposes the input the orchestrator passed in. */
  interface SearchInput {
    queryEmbedding?: number[] | null;
    embeddingWarning?: string;
  }
  const searchSpy = () => vi.fn(async (_input: SearchInput) => ({ hits: [], warnings: [] }));

  function deps(
    embedTextFn: ReturnType<typeof vi.fn>,
    similaritySearchPartnersFn = searchSpy(),
    neighbors: NearbyCity[] = nearbyCities,
  ) {
    return {
      deps: {
        getPartnersByCityFn: vi.fn(async () => [row(1)]),
        findNearbyCitiesFn: vi.fn(async () => neighbors),
        similaritySearchPartnersFn,
        embedTextFn,
      } as never,
      similaritySearchPartnersFn,
    };
  }

  const WIDE = { minPartners: 10, maxCities: 5 };

  it("calls the embedder exactly once regardless of how many cities are searched", async () => {
    const embedTextFn = vi.fn(async (_text: string, _opts?: { signal?: AbortSignal }) => [0.1, 0.2, 0.3]);
    const { deps: d, similaritySearchPartnersFn } = deps(embedTextFn);
    await resolvePartners({ city: CITY, intent: INTENT, config: WIDE }, d);
    expect(similaritySearchPartnersFn.mock.calls.length).toBeGreaterThan(1);
    expect(embedTextFn).toHaveBeenCalledTimes(1);
    // Second arg is a fresh per-call timeout AbortSignal (lib/timeout.ts) —
    // assert only the text, not the signal instance.
    expect(embedTextFn.mock.calls[0][0]).toBe(INTENT.text);
  });

  it("hands the same embedding to every candidate city", async () => {
    const vector = [0.1, 0.2, 0.3];
    const embedTextFn = vi.fn(async () => vector);
    const { deps: d, similaritySearchPartnersFn } = deps(embedTextFn);
    await resolvePartners({ city: CITY, intent: INTENT, config: WIDE }, d);
    for (const [input] of similaritySearchPartnersFn.mock.calls) {
      expect(input.queryEmbedding).toBe(vector);
    }
  });

  it("degrades to a null embedding once, without aborting the search (E25)", async () => {
    const embedTextFn = vi.fn(async () => {
      throw new Error("embedding provider down");
    });
    const { deps: d, similaritySearchPartnersFn } = deps(embedTextFn);
    const result = await resolvePartners({ city: CITY, intent: INTENT, config: WIDE }, d);
    expect(embedTextFn).toHaveBeenCalledTimes(1); // not retried per city
    for (const [input] of similaritySearchPartnersFn.mock.calls) {
      expect(input.queryEmbedding).toBeNull();
      expect(input.embeddingWarning).toMatch(/degraded to text-only search/);
    }
    expect(result.home).toHaveLength(1); // home city survives regardless
  });

  it("does not embed at all when there are no candidate cities to search", async () => {
    const embedTextFn = vi.fn(async () => [0.1]);
    const { deps: d } = deps(embedTextFn, searchSpy(), []);
    await resolvePartners({ city: CITY, intent: INTENT, config: WIDE }, d);
    expect(embedTextFn).not.toHaveBeenCalled();
  });
});
