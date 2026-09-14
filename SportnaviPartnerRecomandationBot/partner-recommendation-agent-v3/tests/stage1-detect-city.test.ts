import { describe, expect, it } from "vitest";
import { detectCity } from "../workflow/stages/1-detect-city";
import { ctx, fakeBackend, fakeLlm, resolveKnownCity } from "./_fakes";

const Q = "Ich suche Physiotherapie in Dortmund";

describe("stage 1 — detect city", () => {
  it("uses the explicitly mentioned city", async () => {
    const r = await detectCity({ query: Q }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmund" }) }));
    expect(r.output.target).toMatchObject({ canonical: "Dortmund", source: "explicit", mention: "Dortmund", confidence: 1 });
    expect(r.output.attempts).toHaveLength(1);
    expect(r.output.attempts[0]?.accepted).toBe(true);
  });

  it("falls back to the home city when no city is mentioned", async () => {
    const r = await detectCity({ query: "Ich suche Yoga", homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ cityMention: null }) }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.output.cityMention).toBeNull();
  });

  it("falls back to the most recent session city after the home city", async () => {
    const r = await detectCity({ query: "Ich suche Yoga", sessionCities: ["Essen", "Bochum"] }, ctx({}, { llm: fakeLlm({ cityMention: null }) }));
    expect(r.output.target).toMatchObject({ canonical: "Essen", source: "session" });
  });

  it("an explicit targetCity override wins and skips the model", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund" });
    const r = await detectCity({ query: Q }, ctx({ targetCity: "Bochum" }, { llm }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "override" });
    expect(llm.calls).toEqual([]);
  });

  it("rejects a low-confidence resolution and moves to the next candidate", async () => {
    const backend = fakeBackend({
      resolveCityFuzzy: (p) => (p === "Dortmnd" ? { city: "Dortmund", lat: 51.5, lon: 7.4, sim: 0.4 } : resolveKnownCity(p)),
    });
    const r = await detectCity({ query: Q, homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmnd" }), backend }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.output.attempts[0]).toMatchObject({ source: "explicit", accepted: false });
    expect(r.output.attempts[0]?.reason).toMatch(/confidence/);
  });

  it("returns no target when nothing resolves (run will ask for clarification)", async () => {
    const r = await detectCity({ query: "Ich suche Yoga" }, ctx({}, { llm: fakeLlm({ cityMention: null }) }));
    expect(r.output.target).toBeNull();
    expect(r.warnings?.[0]).toMatch(/no city/i);
  });

  it("treats a model failure as 'no mention' with a warning, not an error", async () => {
    const r = await detectCity({ query: Q, homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ failDetect: new Error("azure down") }) }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.warnings?.some((w) => w.includes("azure down"))).toBe(true);
  });

  it("a resolver exception is a stage error, not a clarification", async () => {
    const backend = fakeBackend({ resolveCityFuzzy: new Error("db down") });
    await expect(detectCity({ query: Q, homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmund" }), backend }))).rejects.toThrow(/db down/);
  });

  it("a mention the directory does not know still falls through to the home city (no throw)", async () => {
    const backend = fakeBackend({ resolveCityFuzzy: (p) => (p === "Atlantis" ? null : resolveKnownCity(p)) });
    const r = await detectCity({ query: "Yoga in Atlantis", homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ cityMention: "Atlantis" }), backend }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.output.attempts[0]).toMatchObject({ source: "explicit", mention: "Atlantis", accepted: false, reason: "no matching city in the directory" });
  });

  it("records the config it used", async () => {
    const r = await detectCity({ query: Q }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmund" }) }));
    expect(r.config).toEqual({ cityConfidenceMin: 0.6, targetCity: undefined });
    expect(r.counts).toEqual({ attempts: 1 });
  });
});
