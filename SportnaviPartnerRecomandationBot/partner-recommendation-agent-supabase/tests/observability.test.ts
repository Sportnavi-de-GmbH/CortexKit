import { describe, expect, it, vi, afterEach } from "vitest";
import { emitResolutionEvent } from "../lib/observability";
import type { ResolvedCity, ResolvedPartnerSet, ResolutionMeta } from "../lib/partners/types";

const CITY: ResolvedCity = {
  input: "Aalen",
  canonical: "Aalen",
  aliases: ["Aalen"],
  centroid: { lat: 48.83, lng: 10.1 },
  partnerCount: 2,
  confidence: 0.97,
};

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

function setOf(overrides: Partial<ResolvedPartnerSet> = {}): ResolvedPartnerSet {
  return {
    requestedCity: CITY,
    home: [
      {
        id: 17350,
        name: "TopFit - Aalen",
        city: "Aalen",
        tags: ["krafttraining"],
        summary: "s",
        website_url: null,
        source: "home",
        sourceCity: "Aalen",
      },
    ],
    filled: [],
    citiesUsed: ["Aalen"],
    meta: meta(),
    ...overrides,
  };
}

/**
 * ASYNC because emitResolutionEvent defers the actual `console.log` with
 * `queueMicrotask` — it is a diagnostic and must not sit on the request path.
 * The payload is still built synchronously (so a malformed set still cannot
 * throw into the caller); only the write is deferred. Yielding to the
 * macrotask queue here flushes any pending microtasks first.
 */
async function captureLoggedEvent(fn: () => void): Promise<Record<string, unknown>> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(spy).toHaveBeenCalledTimes(1);
  const [line] = spy.mock.calls[0] as [string];
  spy.mockRestore();
  return JSON.parse(line);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitResolutionEvent", () => {
  it("logs exactly one JSON line to stdout with the documented shape", async () => {
    const set = setOf({
      filled: [
        {
          id: 101,
          name: "Nearby",
          city: "Ulm",
          tags: [],
          summary: "s",
          website_url: null,
          source: "nearby",
          sourceCity: "Ulm",
          similarity: 0.8,
          distanceKm: 55,
        },
      ],
      citiesUsed: ["Aalen", "Ulm"],
      meta: meta({ totalReturned: 2, timingsMs: { homeFetch: 12, gapFill: 34 } }),
    });

    const event = await captureLoggedEvent(() => emitResolutionEvent(set, { requestId: "req-1" }));

    expect(event).toMatchObject({
      requestId: "req-1",
      requestedCity: "Aalen",
      homeCount: 1,
      filledCount: 1,
      citiesUsed: ["Aalen", "Ulm"],
      gap: 11, // minRequired(12) - homeCount(1)
      minMet: true,
      cappedAtMax: false,
      citiesExhausted: false,
      warningsCount: 0,
      timingsMs: { homeFetch: 12, gapFill: 34 },
    });
    expect(Array.isArray(event.warningCodes)).toBe(true);
  });

  it("requestedCity is the CANONICAL city name, never the raw user input", async () => {
    const set = setOf({
      requestedCity: { ...CITY, input: "aalen (raw typo)", canonical: "Aalen" },
    });
    const event = await captureLoggedEvent(() => emitResolutionEvent(set, { requestId: "req-2" }));
    expect(event.requestedCity).toBe("Aalen");
  });

  it("contains no PII fields and no partner names/ids", async () => {
    const set = setOf();
    const event = await captureLoggedEvent(() => emitResolutionEvent(set, { requestId: "req-3" }));

    const json = JSON.stringify(event);
    expect(json).not.toContain("17350");
    expect(json).not.toContain("TopFit");
    expect(json).not.toMatch(/email/i);
    expect(json).not.toMatch(/phone/i);
    expect(event).not.toHaveProperty("partners");
    expect(event).not.toHaveProperty("home");
    expect(event).not.toHaveProperty("filled");
  });

  it("classifies free-text warnings into codes, not raw strings, and dedupes", async () => {
    const set = setOf({
      meta: meta({
        warnings: [
          'minPartners (50) > maxPartners (10); clamping minPartners to 10.',
          'Home city has 20 partner(s); trimmed to 10 via "quality".',
          '3 nearby candidate(s) rejected below similarity floor.',
          '3 nearby candidate(s) rejected below similarity floor.', // duplicate on purpose
        ],
      }),
    });

    const event = await captureLoggedEvent(() => emitResolutionEvent(set, { requestId: "req-4" }));

    expect(event.warningsCount).toBe(4);
    expect(event.warningCodes).toEqual(
      expect.arrayContaining(["config_min_clamped_to_max", "home_overflow_trimmed", "similarity_floor_rejects"]),
    );
    // Deduped: 3 distinct codes from 4 warnings (one repeated).
    expect((event.warningCodes as string[]).length).toBe(3);
    // No raw warning text should appear verbatim in the logged codes.
    for (const code of event.warningCodes as string[]) {
      expect(code).not.toMatch(/clamping minPartners/);
    }
  });

  it("never throws, even with a broken/malformed set object", async () => {
    const brokenSets: unknown[] = [
      {},
      { requestedCity: null, home: null, filled: null, citiesUsed: null, meta: null },
      { meta: { warnings: null } },
      null,
      undefined,
    ];

    for (const broken of brokenSets) {
      expect(() =>
        emitResolutionEvent(broken as ResolvedPartnerSet, { requestId: "req-broken" }),
      ).not.toThrow();
    }
  });
});
