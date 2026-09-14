import { describe, expect, it } from "vitest";
import { ctx, fakeEmbed, fakeLlm, ruhrWorld } from "./_fakes";

describe("fakes", () => {
  it("ruhrWorld answers the six-method facade", async () => {
    const b = ruhrWorld();
    expect((await b.resolveCityFuzzy("dortmund"))?.city).toBe("Dortmund");
    expect((await b.cityCentroids()).length).toBe(7);
    const rows = await b.matchPartners({ queryEmbedding: null, queryText: "x", filters: { city: "Bochum" }, matchCount: 2 });
    expect(rows.map((r) => r.partner_id)).toEqual([201, 202]);
    expect(b.searchedCities()).toEqual(["Bochum"]);
  });
  it("fake embed and llm record calls", async () => {
    const e = fakeEmbed();
    await e("q");
    expect(e.calls).toEqual(["q"]);
    const l = fakeLlm({ cityMention: "Bochum" });
    expect(await l.detectCity("q", { signal: AbortSignal.timeout(100) })).toEqual({ cityMention: "Bochum" });
    expect(await l.reformulate("q", { maxChars: 100, signal: AbortSignal.timeout(100) })).toEqual({ text: "REFORMULATED: q" });
    expect(l.calls.map((c) => c.fn)).toEqual(["detectCity", "reformulate"]);
  });
  it("ctx builds a validated config", () => {
    expect(ctx({ searchRadiusKm: 50 }).config.searchRadiusKm).toBe(50);
  });
});
