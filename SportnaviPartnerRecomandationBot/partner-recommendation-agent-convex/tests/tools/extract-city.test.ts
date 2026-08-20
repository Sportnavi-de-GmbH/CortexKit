import { describe, expect, it } from "vitest";
import { extractCityAndIntent } from "../../lib/partners/extract-city";
import { fakeConvex } from "./_fakes";

describe("extractCityAndIntent", () => {
  it("returns city: null when the LLM finds no location and no channelCity is given (E4)", async () => {
    const convex = fakeConvex();
    const out = await extractCityAndIntent(
      { requestText: "Ich suche einen Yogakurs" },
      {
        extractFn: async () => ({ city: null, intentText: "Yogakurs", tags: ["yoga"] }),
        convex,
      },
    );
    expect(out.city).toBeNull();
    expect(out.intent).toEqual({ text: "Yogakurs", tags: ["yoga"] });
    expect(convex.calls).toHaveLength(0);
  });

  it("falls back to channelCity when the LLM finds no location", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: { city: "Bochum", lat: 51.48, lon: 7.22, sim: 0.9 } });
    const out = await extractCityAndIntent(
      { requestText: "Klettern bitte", channelCity: "Bochum" },
      { extractFn: async () => ({ city: null, intentText: "Klettern", tags: [] }), convex },
    );
    expect(out.city?.canonical).toBe("Bochum");
  });

  it("builds aliases/centroid/confidence from the single resolve_city_fuzzy row", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: { city: "Köln", lat: 50.9, lon: 6.95, sim: 0.87 } });
    const out = await extractCityAndIntent(
      { requestText: "Klettern in Koeln" },
      { extractFn: async () => ({ city: "Koeln", intentText: "Klettern", tags: ["klettern"] }), convex },
    );
    expect(out.city).toEqual({
      input: "Koeln",
      canonical: "Köln",
      aliases: ["Köln"],
      centroid: { lat: 50.9, lng: 6.95 },
      // Always 0: the second `count(*)` query that used to populate this was
      // removed. Nothing in the request path ever read it, and it cost a
      // fully-serialized round-trip on every search. See resolveCityFuzzy.
      partnerCount: 0,
      confidence: 0.87,
    });
    expect(out.intent).toEqual({ text: "Klettern", tags: ["klettern"] });
  });

  it("does not issue a partner-count query (it was dead weight on the hot path)", async () => {
    const convex = fakeConvex({
      resolveCityFuzzy: { city: "Köln", lat: 50.9, lon: 6.95, sim: 0.87 },
    });

    await extractCityAndIntent(
      { requestText: "Klettern in Koeln" },
      { extractFn: async () => ({ city: "Koeln", intentText: "Klettern", tags: [] }), convex },
    );

    // EXACTLY one backend call. A second, fully-serialized count(*) used to
    // run here to populate `partnerCount`, and nothing in the request path
    // ever read the result. Asserting the call COUNT is the portable form of
    // the original "the partners table was never touched" assertion.
    expect(convex.calls.map((c) => c.fn)).toEqual(["resolveCityFuzzy"]);
  });

  it("returns a zero-confidence stub when resolve_city_fuzzy finds no match (E2)", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: null });
    const out = await extractCityAndIntent(
      { requestText: "Klettern in Nirgendwoistan" },
      { extractFn: async () => ({ city: "Nirgendwoistan", intentText: "Klettern", tags: [] }), convex },
    );
    expect(out.city).toEqual({
      input: "Nirgendwoistan",
      canonical: "Nirgendwoistan",
      aliases: [],
      centroid: null,
      partnerCount: 0,
      confidence: 0,
    });
  });

  it("uses requestText as the intent text when the LLM returns an empty intentText", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: null });
    const out = await extractCityAndIntent(
      { requestText: "Bochum bitte" },
      { extractFn: async () => ({ city: "Bochum", intentText: "", tags: [] }), convex },
    );
    expect(out.intent.text).toBe("Bochum bitte");
  });
});

describe("extractCityAndIntent — lowConfidence / ambiguityPolicy (E1)", () => {
  it("flags lowConfidence when the resolved city's confidence is below cityConfidenceMin", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: { city: "Bochum", lat: 51.48, lon: 7.22, sim: 0.4 } });
    const out = await extractCityAndIntent(
      { requestText: "Klettern in Bochm", config: { cityConfidenceMin: 0.6 } },
      { extractFn: async () => ({ city: "Bochm", intentText: "Klettern", tags: [] }), convex },
    );
    expect(out.lowConfidence).toBe(true);
    expect(out.ambiguityPolicy).toBe("ask"); // DEFAULT_CONFIG default
  });

  it("does not flag lowConfidence when confidence meets cityConfidenceMin", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: { city: "Bochum", lat: 51.48, lon: 7.22, sim: 0.9 } });
    const out = await extractCityAndIntent(
      { requestText: "Klettern in Bochum", config: { cityConfidenceMin: 0.6 } },
      { extractFn: async () => ({ city: "Bochum", intentText: "Klettern", tags: [] }), convex },
    );
    expect(out.lowConfidence).toBe(false);
  });

  it("passes through an ambiguityPolicy override", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: { city: "Bochum", lat: 51.48, lon: 7.22, sim: 0.4 } });
    const out = await extractCityAndIntent(
      {
        requestText: "Klettern in Bochm",
        config: { cityConfidenceMin: 0.6, ambiguityPolicy: "proceed-and-disclose" },
      },
      { extractFn: async () => ({ city: "Bochm", intentText: "Klettern", tags: [] }), convex },
    );
    expect(out.lowConfidence).toBe(true);
    expect(out.ambiguityPolicy).toBe("proceed-and-disclose");
  });

  it("lowConfidence is always false when no city could be resolved (E4)", async () => {
    const convex = fakeConvex();
    const out = await extractCityAndIntent(
      { requestText: "Ich suche einen Yogakurs" },
      { extractFn: async () => ({ city: null, intentText: "Yogakurs", tags: ["yoga"] }), convex },
    );
    expect(out.lowConfidence).toBe(false);
    expect(out.ambiguityPolicy).toBe("ask");
  });

  it("the zero-confidence no-coverage stub (E2) is flagged lowConfidence too", async () => {
    const convex = fakeConvex({ resolveCityFuzzy: null });
    const out = await extractCityAndIntent(
      { requestText: "Klettern in Nirgendwoistan" },
      { extractFn: async () => ({ city: "Nirgendwoistan", intentText: "Klettern", tags: [] }), convex },
    );
    expect(out.lowConfidence).toBe(true);
  });
});
