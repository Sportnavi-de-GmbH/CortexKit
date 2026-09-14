import { describe, expect, it } from "vitest";
import { cosineSimilarity, roundScore, scoreRelevance } from "../lib/reused/score-relevance";
import { haversineKm, normalizeCityKey } from "../lib/reused/nearby-cities";
import { runWithLimit } from "../lib/reused/limiter";
import { withTimeout, TimeoutError } from "../lib/reused/timeout";

describe("reused modules", () => {
  it("scores cosine relevance rounded to 4 dp", () => {
    const q = [1, 0];
    const scores = scoreRelevance(q, new Map([[1, [1, 0]], [2, [0, 1]], [3, [0.7071, 0.7071]]]));
    expect(scores.get(1)).toBe(1);
    expect(scores.get(2)).toBe(0);
    expect(scores.get(3)).toBe(0.7071);
    expect(roundScore(cosineSimilarity([1, 1], [1, 1]))).toBe(1);
  });

  it("measures Dortmund→Bochum at roughly 17 km", () => {
    const km = haversineKm({ lat: 51.5136, lng: 7.4653 }, { lat: 51.4818, lng: 7.2162 });
    expect(km).toBeGreaterThan(16);
    expect(km).toBeLessThan(19);
    expect(normalizeCityKey("  Düsseldorf ")).toBe("duesseldorf");
  });

  it("bounds concurrency and settles every task", async () => {
    const stats = { peakConcurrency: 0 };
    const results = await runWithLimit([async () => 1, async () => { throw new Error("x"); }], 1, stats);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]?.status).toBe("rejected");
    expect(stats.peakConcurrency).toBe(1);
  });

  it("times out", async () => {
    await expect(withTimeout(new Promise(() => {}), 5, "never")).rejects.toBeInstanceOf(TimeoutError);
  });
});
