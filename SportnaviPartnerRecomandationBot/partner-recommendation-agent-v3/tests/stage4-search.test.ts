import { describe, expect, it } from "vitest";
import { search } from "../workflow/stages/4-search";
import { ctx, fakeEmbed, ruhrWorld } from "./_fakes";
import type { SearchCity } from "../workflow/types";

const CITIES: SearchCity[] = [
  { city: "Dortmund", role: "target", distanceKm: 0, partnerCount: 20 },
  { city: "Bochum", role: "nearby", distanceKm: 17.3, partnerCount: 30 },
  { city: "Lünen", role: "nearby", distanceKm: 12, partnerCount: 3 },
];

describe("stage 4 — search", () => {
  it("embeds the retrieval query exactly once and searches every city with that vector", async () => {
    const embed = fakeEmbed();
    const backend = ruhrWorld();
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({ topKSimilarity: 5 }, { embed, backend }));
    expect(embed.calls).toEqual(["RQ"]);
    expect(backend.searchedCities().sort()).toEqual(["Bochum", "Dortmund", "Lünen"]);
    for (const call of backend.callsTo("matchPartners")) {
      const a = call.args as { queryEmbedding: number[]; queryText: string; matchCount: number };
      expect(a.queryEmbedding).toBe(r.queryEmbedding);
      expect(a.queryText).toBe("RQ");
      expect(a.matchCount).toBe(5);
    }
    expect(r.output.embedding).toMatchObject({ model: "text-embedding-3-small", dimensions: 1536 });
    expect(r.output.embedding.preview).toHaveLength(8);
    expect(r.output.perCity.map((c) => c.city)).toEqual(["Dortmund", "Bochum", "Lünen"]);
    expect(r.output.perCity[0]).toMatchObject({ role: "target", requested: 5, returned: 5, kept: 5 });
    expect(r.output.candidates).toHaveLength(5 + 3 + 1);
    expect(r.output.candidates.find((c) => c.id === 201)).toMatchObject({ role: "nearby", sourceCity: "Bochum", distanceKm: 17.3, rankInCity: 0 });
  });

  it("drops rows below similarityThreshold and counts them", async () => {
    // ruhrWorld similarity = 0.5 − 0.01·i ⇒ with threshold 0.485 only ranks 0 and 1 survive per city
    // (Dortmund 2 of 5, Bochum 2 of 3, Lünen 1 of 1 ⇒ 5 kept, 4 dropped)
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({ topKSimilarity: 5, similarityThreshold: 0.485 }));
    expect(r.output.perCity[0]).toMatchObject({ returned: 5, kept: 2 });
    expect(r.counts).toMatchObject({ citiesSearched: 3, candidatesReturned: 9, belowThreshold: 4, candidates: 5 });
  });

  it("a failing city is a warning, the others still return", async () => {
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({}, { backend: ruhrWorld({ failCities: ["Bochum"] }) }));
    expect(r.output.perCity.find((c) => c.city === "Bochum")).toMatchObject({ returned: 0, kept: 0, failed: expect.stringContaining("db down") });
    expect(r.warnings?.[0]).toMatch(/Bochum/);
    expect(r.output.candidates.some((c) => c.sourceCity === "Dortmund")).toBe(true);
    expect(r.counts?.citiesFailed).toBe(1);
  });

  it("bounds parallelism", async () => {
    let inFlight = 0, peak = 0;
    const backend = ruhrWorld();
    const orig = backend.matchPartners.bind(backend);
    backend.matchPartners = async (a, o) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); try { return await orig(a, o); } finally { inFlight--; } };
    await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({ maxParallelSearches: 1 }, { backend }));
    expect(peak).toBe(1);
  });

  it("throws when the embedding fails (the runner records it as the stage error)", async () => {
    await expect(search({ retrievalQuery: "RQ", cities: CITIES }, ctx({}, { embed: fakeEmbed(undefined, new Error("embed down")) }))).rejects.toThrow("embed down");
  });

  it("records filters and config", async () => {
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx());
    expect(r.filters).toEqual({ cities: ["Dortmund", "Bochum", "Lünen"], similarityThreshold: 0.2 });
    expect(r.config).toEqual({ topKSimilarity: 15, similarityThreshold: 0.2, maxParallelSearches: 4 });
  });
});
