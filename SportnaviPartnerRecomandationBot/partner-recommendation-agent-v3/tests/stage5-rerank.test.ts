import { describe, expect, it } from "vitest";
import { combineAndDedupe, locationTerm, rerank } from "../workflow/stages/5-rerank";
import { ctx, ruhrWorld } from "./_fakes";
import type { Candidate } from "../workflow/types";

const cand = (id: number, city: string, role: "target" | "nearby", distanceKm: number, similarity = 0.5, rankInCity = 0): Candidate =>
  ({ id, name: `P${id}`, city, tags: [], role, sourceCity: city, distanceKm, similarity, rankInCity });

describe("stage 5 — rerank", () => {
  it("dedupes by id, target occurrence wins, then nearer", () => {
    const { unique, duplicatesRemoved } = combineAndDedupe([
      cand(1, "Bochum", "nearby", 17), cand(1, "Dortmund", "target", 0), cand(2, "Hagen", "nearby", 20), cand(2, "Lünen", "nearby", 12),
    ]);
    expect(duplicatesRemoved).toBe(2);
    expect(unique.find((c) => c.id === 1)?.role).toBe("target");
    expect(unique.find((c) => c.id === 2)?.sourceCity).toBe("Lünen");
  });

  it("location term: +bonus in the target city, linear penalty up to the radius, clamped", () => {
    const cfg = ctx({ searchRadiusKm: 30, targetCityBonus: 0.05, maxDistancePenalty: 0.05 }).config;
    expect(locationTerm("target", 0, cfg)).toBe(0.05);
    expect(locationTerm("nearby", 15, cfg)).toBeCloseTo(-0.025, 6);
    expect(locationTerm("nearby", 30, cfg)).toBeCloseTo(-0.05, 6);
    expect(locationTerm("nearby", 60, cfg)).toBeCloseTo(-0.05, 6);
  });

  it("the owner's example: a clearly more relevant nearby partner beats a weak target partner, a strong target partner still wins", async () => {
    // A 0.78 Dortmund · B 0.65 Dortmund · C 0.86 Bochum 18 km · D 0.81 Lünen 15 km · E 0.72 Hagen 20 km
    const backend = ruhrWorld({ relevance: { 101: 0.78, 102: 0.65, 201: 0.86, 301: 0.81, 501: 0.72 } });
    const candidates = [cand(101, "Dortmund", "target", 0), cand(102, "Dortmund", "target", 0), cand(201, "Bochum", "nearby", 18), cand(301, "Lünen", "nearby", 15), cand(501, "Hagen", "nearby", 20)];
    const r = await rerank({ candidates, queryEmbedding: [1] }, ctx({ searchRadiusKm: 30, topKReranked: 5 }, { backend }));
    expect(r.output.kept.map((k) => k.id)).toEqual([101, 201, 301, 102, 501]);
    expect(r.output.kept[0]).toMatchObject({ rank: 1, finalScore: 0.83, relevanceSource: "embedding" });
    expect(r.output.kept[1]?.finalScore).toBeCloseTo(0.83, 3); // 0.86 − 0.03 — ties broken target-first
    expect(r.output.kept[3]).toMatchObject({ id: 102, finalScore: 0.7 });
  });

  it("drops nearby candidates below minNearbyRelevance but never target ones; cut rows stay in the table", async () => {
    const backend = ruhrWorld({ relevance: { 101: 0.05, 201: 0.05, 202: 0.9 } });
    const r = await rerank({ candidates: [cand(101, "Dortmund", "target", 0), cand(201, "Bochum", "nearby", 17), cand(202, "Bochum", "nearby", 17, 0.5, 1)], queryEmbedding: [1] }, ctx({ minNearbyRelevance: 0.15, topKReranked: 1 }, { backend }));
    expect(r.output.kept.map((k) => k.id)).toEqual([202]);
    const rows = Object.fromEntries(r.output.rows.map((x) => [x.id, x]));
    expect(rows[201]).toMatchObject({ kept: false, dropReason: expect.stringContaining("minNearbyRelevance"), rank: null });
    expect(rows[101]).toMatchObject({ kept: false, dropReason: expect.stringContaining("topKReranked") });
    expect(r.counts).toMatchObject({ combined: 3, duplicatesRemoved: 0, floorDropped: 1, kept: 1 });
  });

  it("falls back to the directory similarity when a stored embedding is missing", async () => {
    const backend = ruhrWorld();
    backend.getPartnerEmbeddings = async () => [];
    const r = await rerank({ candidates: [cand(101, "Dortmund", "target", 0, 0.42)], queryEmbedding: [1] }, ctx({}, { backend }));
    expect(r.output.rows[0]).toMatchObject({ relevance: 0.42, relevanceSource: "similarity", finalScore: 0.47 });
    expect(r.warnings?.[0]).toMatch(/embedding/);
  });

  it("is deterministic on ties: target first, nearer, in-city rank, id", async () => {
    const backend = ruhrWorld({ relevance: { 301: 0.5, 401: 0.5, 501: 0.5 } });
    const r = await rerank({ candidates: [cand(501, "Hagen", "nearby", 10, 0.5, 0), cand(401, "X", "nearby", 10, 0.5, 1), cand(301, "Y", "nearby", 10, 0.5, 0)], queryEmbedding: [1] }, ctx({}, { backend }));
    expect(r.output.kept.map((k) => k.id)).toEqual([301, 501, 401]);
  });
});
