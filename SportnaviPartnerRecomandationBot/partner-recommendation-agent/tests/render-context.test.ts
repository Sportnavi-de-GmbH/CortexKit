import { describe, expect, it } from "vitest";
import { renderTier1, renderTier2, renderMetaSummary } from "../lib/partners/render-context";
import type { Recommendation } from "../lib/partners/build-recommendations";
import type { PartnerLite, ResolvedCity, ResolvedPartnerSet, ResolutionMeta } from "../lib/partners/types";

const CITY: ResolvedCity = {
  input: "Aalen",
  canonical: "Aalen",
  aliases: ["Aalen"],
  centroid: { lat: 48.83, lng: 10.1 },
  partnerCount: 2,
  confidence: 0.97,
};

function lite(id: number, overrides: Partial<PartnerLite> = {}): PartnerLite {
  return {
    id,
    name: `Partner ${id}`,
    city: "Aalen",
    tags: ["krafttraining", "cardio"],
    summary: `summary ${id}`,
    website_url: null,
    source: "home",
    sourceCity: "Aalen",
    ...overrides,
  };
}

function meta(overrides: Partial<ResolutionMeta> = {}): ResolutionMeta {
  return {
    minRequired: 12,
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

const REAL_LLM_PROFILE = `# Partner 17350 — TopFit - Aalen Ulmerstrasse

Ort: Aalen
Adresse: Ulmerstraße 45, 73431   Aalen
Telefon: +4973618064660
E-Mail: not_available
Website: https://www.topfit.fitness/aalen-ulmerstrasse
Social Media: not_available
Google Maps: https://www.google.com/maps/search/?api=1&query=48.8344577,10.1000072310816

Schwerpunkte: krafttraining, cardio, functional training

Profil:
## Überblick
Der TopFit Fitnessclub Aalen Ulmerstraße ist ein rund um die Uhr geöffnetes Fitnessstudio.

## Kontakt & Anfahrt
TopFit Fitnessclub Aalen Ulmerstraße, Ulmerstraße 45, 73431 Aalen. Telefon: 07361 8064660. Mitgliederverwaltung: verwaltung@gfa247.com.

## Öffnungszeiten
Mo – So: 24 Stunden geöffnet (auch an Feiertagen).

Kursangebot:
Fitness Check | Five Zirkel`;

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    partnerId: 17350,
    name: "TopFit - Aalen Ulmerstrasse",
    city: "Aalen",
    source: "home",
    sourceCity: "Aalen",
    llmProfile: REAL_LLM_PROFILE,
    ...overrides,
  };
}

describe("renderTier1", () => {
  it("home always first, home lines carry NO similarity/distance", () => {
    const set = setOf([lite(1), lite(2)], [], ["Aalen"]);
    const out = renderTier1(set);

    expect(out.startsWith("HOME CITY PARTNERS:")).toBe(true);
    expect(out).toContain("# Partner 1 — Partner 1 (Aalen)   [home]");
    expect(out).toContain("# Partner 2 — Partner 2 (Aalen)   [home]");
    expect(out).not.toContain("Similarity score:");
    expect(out).not.toContain("Borrowed from:");
    expect(out).not.toContain("Distance");
  });

  it("nearby lines carry BOTH similarity and distance metadata", () => {
    const filled = [
      lite(101, {
        source: "nearby",
        sourceCity: "Schwäbisch Gmünd",
        similarity: 0.71,
        distanceKm: 25,
      }),
    ];
    const set = setOf([lite(1)], filled, ["Aalen", "Schwäbisch Gmünd"]);
    const out = renderTier1(set);

    expect(out).toContain("# Partner 101 — Partner 101 (Aalen)   [nearby]");
    expect(out).toContain("Borrowed from: Schwäbisch Gmünd, ~25 km from Aalen");
    expect(out).toContain("Similarity score: 0.71");
  });

  it("home section always precedes the nearby section", () => {
    const filled = [lite(101, { source: "nearby", sourceCity: "Ulm", similarity: 0.5, distanceKm: 55 })];
    const set = setOf([lite(1)], filled, ["Aalen", "Ulm"]);
    const out = renderTier1(set);

    const homeIdx = out.indexOf("HOME CITY PARTNERS:");
    const nearbyIdx = out.indexOf("NEARBY CITY PARTNERS:");
    expect(homeIdx).toBeGreaterThanOrEqual(0);
    expect(nearbyIdx).toBeGreaterThan(homeIdx);
  });

  it("empty filled → no NEARBY CITY PARTNERS section at all", () => {
    const set = setOf([lite(1)], [], ["Aalen"]);
    const out = renderTier1(set);

    expect(out).not.toContain("NEARBY CITY PARTNERS:");
  });

  it("each partner carries a Tags line derived from the partner's tags", () => {
    const set = setOf([lite(1, { tags: ["yoga", "pilates"] })], [], ["Aalen"]);
    const out = renderTier1(set);

    expect(out).toContain("Tags: yoga, pilates");
  });
});

describe("renderMetaSummary", () => {
  it("summarizes counts/flags/warnings without leaking partner content", () => {
    const set = setOf([lite(1)], [], ["Aalen"], {
      minMet: false,
      cappedAtMax: true,
      citiesExhausted: true,
      warnings: ["Only 1 partner(s) found near \"Aalen\" (wanted 12)."],
    });
    const out = renderMetaSummary(set);

    expect(out).toContain("minMet=false");
    expect(out).toContain("cappedAtMax=true");
    expect(out).toContain("citiesExhausted=true");
    expect(out).not.toContain("Partner 1");
  });

  it("paraphrases warnings into coded, user-safe summaries — never the raw internal text", () => {
    const set = setOf([lite(1)], [], ["Aalen"], {
      warnings: [
        "2 nearby candidate(s) rejected below similarity floor.",
        'Search failed for "Ulm"; skipped (db timeout after 5000ms).',
      ],
    });
    const out = renderMetaSummary(set);

    expect(out).toContain("2 candidates rejected below the relevance floor");
    expect(out).toContain("1 nearby city was skipped due to a search problem");
    // Raw internal diagnostics must never leak into the model-facing text.
    expect(out).not.toContain("db timeout");
    expect(out).not.toContain("5000ms");
    expect(out).not.toContain("Ulm");
  });

  it("deduplicates warnings that classify to the same code into one phrase with the right count", () => {
    const set = setOf([lite(1)], [], ["Aalen"], {
      warnings: [
        "1 nearby candidate(s) rejected below similarity floor.",
        "1 nearby candidate(s) rejected below similarity floor.",
        "1 nearby candidate(s) rejected below similarity floor.",
      ],
    });
    const out = renderMetaSummary(set);

    expect(out).toContain("3 candidates rejected below the relevance floor");
    // Only one phrase for the repeated code, not three.
    expect(out.match(/rejected below the relevance floor/g)).toHaveLength(1);
  });

  it("renders a clamp warning as a fixed phrase with no raw numbers", () => {
    const set = setOf([lite(1)], [], ["Aalen"], {
      warnings: ["minPartners (50) > maxPartners (10); clamping minPartners to 10."],
    });
    const out = renderMetaSummary(set);

    expect(out).toContain("the requested minimum was capped to the configured maximum");
    expect(out).not.toContain("50");
    expect(out).not.toContain("clamping");
  });
});

describe("renderTier2", () => {
  it("home partners get the [home] header with no Borrowed from / Similarity lines", () => {
    const out = renderTier2([recommendation({ source: "home" })], { requestedCity: "Aalen" });

    expect(out).toContain("# Partner 17350 — TopFit - Aalen Ulmerstrasse (Aalen)   [home]");
    expect(out).not.toContain("Borrowed from:");
    expect(out).not.toContain("Similarity score:");
  });

  it("nearby partners get the [nearby] header WITH Borrowed from / Similarity lines", () => {
    const out = renderTier2(
      [
        recommendation({
          partnerId: 17351,
          name: "TopFit - Schwäbisch Gmünd",
          source: "nearby",
          sourceCity: "Schwäbisch Gmünd",
          distanceKm: 25,
          similarity: 0.71,
        }),
      ],
      { requestedCity: "Aalen" },
    );

    expect(out).toContain("# Partner 17351 — TopFit - Schwäbisch Gmünd (Aalen)   [nearby]");
    expect(out).toContain("Borrowed from: Schwäbisch Gmünd, ~25 km from Aalen");
    expect(out).toContain("Similarity score: 0.71");
  });

  it("includeContactInShortlist=true passes llm_profile through VERBATIM (incl. a Telefon: line)", () => {
    const out = renderTier2([recommendation()], {
      requestedCity: "Aalen",
      includeContactInShortlist: true,
    });

    expect(out).toContain(REAL_LLM_PROFILE);
    expect(out).toContain("Telefon: +4973618064660");
  });

  it("defaults to including contact when includeContactInShortlist is omitted", () => {
    const out = renderTier2([recommendation()], { requestedCity: "Aalen" });
    expect(out).toContain("Telefon: +4973618064660");
  });

  it("includeContactInShortlist=false strips exactly the labeled contact lines and nothing else", () => {
    const out = renderTier2([recommendation()], {
      requestedCity: "Aalen",
      includeContactInShortlist: false,
    });

    // The labeled header lines are gone...
    expect(out).not.toContain("Adresse: Ulmerstraße 45");
    expect(out).not.toContain("Telefon: +4973618064660");
    expect(out).not.toContain("E-Mail: not_available");
    expect(out).not.toContain("Social Media: not_available");
    expect(out).not.toContain("Google Maps: https://www.google.com/maps");

    // ...but everything else, including the free-text "Kontakt & Anfahrt"
    // prose section (which is NOT a labeled line), survives untouched.
    expect(out).toContain("## Kontakt & Anfahrt");
    expect(out).toContain("Telefon: 07361 8064660."); // inside the prose sentence, not a labeled line
    expect(out).toContain("Ort: Aalen");
    expect(out).toContain("## Überblick");
    expect(out).toContain("Kursangebot:");
    expect(out).toContain("Website: https://www.topfit.fitness/aalen-ulmerstrasse");
  });

  it("never truncates — a 25k-char synthetic profile is preserved in full", () => {
    const bigProfile = "# Partner 1 — Big One\n\n" + "x".repeat(25_000);
    const out = renderTier2([recommendation({ partnerId: 1, name: "Big One", llmProfile: bigProfile })], {
      requestedCity: "Aalen",
    });

    expect(out).toContain(bigProfile);
    expect(out.length).toBeGreaterThanOrEqual(bigProfile.length);
  });

  it("joins multiple recommendations into separate blocks", () => {
    const out = renderTier2(
      [recommendation({ partnerId: 1, name: "One" }), recommendation({ partnerId: 2, name: "Two" })],
      { requestedCity: "Aalen" },
    );

    expect(out).toContain("Partner 1 — One");
    expect(out).toContain("Partner 2 — Two");
  });
});
