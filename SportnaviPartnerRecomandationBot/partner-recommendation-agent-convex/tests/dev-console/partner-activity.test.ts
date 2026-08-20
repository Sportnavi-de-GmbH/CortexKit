import { describe, expect, it } from "vitest";
import { buildPartnerActivity } from "../../lib/dev-console/partner-activity";
import type { ResolvedPartnerSet } from "../../lib/partners/types";
import type { BuildRecommendationsOutput } from "../../lib/partners/build-recommendations";

function resolvedSet(overrides: Partial<ResolvedPartnerSet> = {}): ResolvedPartnerSet & { setId: string } {
  return {
    requestedCity: { input: "Bochum", canonical: "Bochum", aliases: ["Bochum"], centroid: null, partnerCount: 8, confidence: 1 },
    home: [{ id: 1, name: "Home Gym", city: "Bochum", tags: [], summary: "s", website_url: null, source: "home", sourceCity: "Bochum" }],
    filled: [],
    citiesUsed: ["Bochum"],
    meta: { minRequired: 5, maxAllowed: 40, maxCities: 4, totalReturned: 1, minMet: false, cappedAtMax: false, citiesExhausted: false, warnings: ["4 partner(s) found near Bochum; shortfall below min"], timingsMs: {} },
    setId: "set-1",
    ...overrides,
  };
}

function recommendationsOutput(overrides: Partial<BuildRecommendationsOutput> = {}): BuildRecommendationsOutput {
  return {
    recommendations: [{ partnerId: 1, name: "Home Gym", city: "Bochum", source: "home", sourceCity: "Bochum", llmProfile: "..." }],
    disclosure: "All 1 result is from Bochum.",
    warnings: [],
    requestedCity: "Bochum",
    includeContactInShortlist: true,
    counts: { homeTotal: 1, homeQualified: 1, shown: 1, resolvedTotal: 1 },
    fitMismatch: false,
    ...overrides,
  };
}

function toolPart(toolName: string, state: "output-available" | "input-available", output?: unknown) {
  return { type: "dynamic-tool", toolName, state, ...(output !== undefined ? { output } : {}) };
}

describe("buildPartnerActivity", () => {
  it("returns one entry per resolve_partners call, newest first", () => {
    const messages = [
      { parts: [toolPart("resolve_partners", "output-available", resolvedSet({ requestedCity: { input: "Essen", canonical: "Essen", aliases: ["Essen"], centroid: null, partnerCount: 3, confidence: 1 } }))] },
      { parts: [toolPart("resolve_partners", "output-available", resolvedSet())] },
    ];

    const activity = buildPartnerActivity(messages);

    expect(activity).toHaveLength(2);
    expect(activity[0].requestedCity).toBe("Bochum");
    expect(activity[1].requestedCity).toBe("Essen");
  });

  it("pairs a resolve_partners entry with its build_recommendations output", () => {
    const messages = [
      { parts: [toolPart("resolve_partners", "output-available", resolvedSet())] },
      { parts: [toolPart("build_recommendations", "output-available", recommendationsOutput())] },
    ];

    const [entry] = buildPartnerActivity(messages);

    expect(entry.homeCount).toBe(1);
    expect(entry.filledCount).toBe(0);
    expect(entry.minMet).toBe(false);
    expect(entry.warnings).toEqual(["4 partner(s) found near Bochum; shortfall below min"]);
    expect(entry.recommendations).toEqual([{ partnerId: 1, name: "Home Gym", city: "Bochum", source: "home" }]);
    expect(entry.disclosure).toBe("All 1 result is from Bochum.");
    expect(entry.buildError).toBeNull();
  });

  it("leaves recommendations null until build_recommendations has run", () => {
    const messages = [{ parts: [toolPart("resolve_partners", "output-available", resolvedSet())] }];

    const [entry] = buildPartnerActivity(messages);

    expect(entry.recommendations).toBeNull();
    expect(entry.disclosure).toBeNull();
  });

  it("surfaces a build_recommendations error without crashing", () => {
    const messages = [
      { parts: [toolPart("resolve_partners", "output-available", resolvedSet())] },
      { parts: [toolPart("build_recommendations", "output-available", { error: "unknown or expired setId — re-run resolve_partners" })] },
    ];

    const [entry] = buildPartnerActivity(messages);

    expect(entry.buildError).toBe("unknown or expired setId — re-run resolve_partners");
    expect(entry.recommendations).toBeNull();
  });

  it("ignores tool calls that are still running (no output yet)", () => {
    const messages = [{ parts: [toolPart("resolve_partners", "input-available")] }];

    expect(buildPartnerActivity(messages)).toEqual([]);
  });

  it("ignores unrelated tool calls", () => {
    const messages = [{ parts: [toolPart("extract_city", "output-available", { city: "Bochum" })] }];

    expect(buildPartnerActivity(messages)).toEqual([]);
  });

  it("does not attribute a later resolve's build_recommendations output to an earlier, orphaned resolve_partners call", () => {
    const messages = [
      {
        parts: [
          toolPart(
            "resolve_partners",
            "output-available",
            resolvedSet({ requestedCity: { input: "Essen", canonical: "Essen", aliases: ["Essen"], centroid: null, partnerCount: 0, confidence: 1 } }),
          ),
        ],
      },
      // No build_recommendations follows the Essen resolve — the agent
      // skipped straight to a second resolve_partners for a different city.
      { parts: [toolPart("resolve_partners", "output-available", resolvedSet())] },
      { parts: [toolPart("build_recommendations", "output-available", recommendationsOutput())] },
    ];

    const activity = buildPartnerActivity(messages);

    expect(activity).toHaveLength(2);

    const [bochumEntry, essenEntry] = activity;
    expect(essenEntry.requestedCity).toBe("Essen");
    expect(essenEntry.recommendations).toBeNull();
    expect(essenEntry.disclosure).toBeNull();

    expect(bochumEntry.requestedCity).toBe("Bochum");
    expect(bochumEntry.recommendations).toEqual([{ partnerId: 1, name: "Home Gym", city: "Bochum", source: "home" }]);
    expect(bochumEntry.disclosure).toBe("All 1 result is from Bochum.");
  });
});
