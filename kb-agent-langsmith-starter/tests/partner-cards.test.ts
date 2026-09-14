/**
 * The contract between the V2 partner agent's tool output and the widget's
 * partner cards.
 *
 * The extractor reads a `dynamic-tool` message part that eve streams to the
 * browser (the model never sees it). Two failures matter and neither is loud:
 * cards rendered from a shape they were not built for (the live Supabase agent
 * returns a different object — it must yield NOTHING, so the widget behaves
 * exactly as before), and a malformed card taking the whole answer down with
 * a thrown error.
 */
import { describe, expect, it } from "vitest";

import { extractPartnerCards } from "../lib/partner-cards";

const CARD = {
  partnerId: 101,
  name: "Yoga Loft Bochum",
  logoUrl: "https://cdn.example/101.png",
  city: "Bochum",
  street: "Kortumstr. 1",
  postalCode: "44787",
  email: "hi@yogaloft.example",
  phone: "+49 234 1",
  websiteUrl: "https://yogaloft.example",
  tags: ["yoga", "pilates"],
  description: "Ruhiges Studio in der Innenstadt.",
  openingHours: "Mo–Fr 7–21 Uhr",
};

function rec(over: Record<string, unknown> = {}) {
  return {
    partnerId: 101,
    name: "Yoga Loft Bochum",
    city: "Bochum",
    source: "requested",
    sourceCity: "Bochum",
    distanceKm: 0,
    finalScore: 0.6,
    card: CARD,
    ...over,
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    request: { city: "bochum", sport: "Yoga", tags: [] },
    status: "ok",
    requestedCity: "Bochum",
    suggestedCity: null,
    citiesSearched: ["Bochum"],
    citiesUsed: ["Bochum"],
    counts: { requestedCityCandidates: 1, nearbyCandidates: 0, duplicatesRemoved: 0, shownFromRequestedCity: 1, shownFromNearby: 0 },
    warnings: [],
    timingsMs: {},
    recommendations: [rec()],
    candidates: [],
    ...over,
  };
}

function toolPart(output: unknown, over: Record<string, unknown> = {}) {
  return { type: "dynamic-tool", toolCallId: "c1", toolName: "find_partners", state: "output-available", output, ...over } as const;
}

const V2_OUTPUT = { kind: "results", stats: { requested: 1, ok: 1, failed: 0 }, results: [result()], renderedText: "…" };

describe("the V2 shape", () => {
  it("yields one group per ok request with the cards in the tool's order", () => {
    const groups = extractPartnerCards([
      { type: "text", text: "Ich schaue mal …" },
      toolPart(V2_OUTPUT),
      { type: "text", text: "Hier sind …" },
    ]);
    expect(groups).not.toBeNull();
    expect(groups).toHaveLength(1);
    expect(groups![0]).toEqual({
      label: "Yoga in Bochum",
      cards: [{ ...CARD, source: "requested", sourceCity: "Bochum", distanceKm: 0 }],
    });
  });

  it("keeps several requests apart and skips the ones that produced no list", () => {
    const out = {
      kind: "results",
      stats: {},
      results: [
        result({ request: { city: "Dortmund", sport: "Tennis" }, requestedCity: "Dortmund", recommendations: [rec({ partnerId: 1, card: { ...CARD, partnerId: 1, name: "TC" } }), rec({ partnerId: 2, source: "nearby", sourceCity: "Bochum", distanceKm: 17.2, card: { ...CARD, partnerId: 2 } })] }),
        result({ request: { city: "Nirgendwo", sport: "Boxen" }, status: "city_unknown", requestedCity: null, recommendations: [] }),
        result({ request: { city: "Essen", sport: "Fußball" }, status: "no_results", recommendations: [] }),
      ],
    };
    const groups = extractPartnerCards([toolPart(out)])!;
    expect(groups.map((g) => g.label)).toEqual(["Tennis in Dortmund"]);
    expect(groups[0]!.cards.map((c) => [c.partnerId, c.source, c.distanceKm])).toEqual([
      [1, "requested", 0],
      [2, "nearby", 17.2],
    ]);
  });

  it("falls back to the typed city when the resolved one is missing", () => {
    const groups = extractPartnerCards([toolPart({ kind: "results", results: [result({ requestedCity: null })] })])!;
    expect(groups[0]!.label).toBe("Yoga in bochum");
  });

  it("normalises missing keys to null (eve drops undefined on the wire) and never throws on junk", () => {
    const { logoUrl: _l, openingHours: _o, description: _d, tags: _t, ...partial } = CARD;
    const groups = extractPartnerCards([
      toolPart({
        kind: "results",
        results: [
          result({
            recommendations: [
              rec({ card: partial }),
              rec({ partnerId: 7, card: "not an object" }),
              rec({ partnerId: 8, name: undefined, card: { partnerId: 8 } }), // no name anywhere
              rec({ partnerId: 9, card: { ...CARD, partnerId: 9, logoUrl: "http://insecure/logo.png", websiteUrl: "javascript:alert(1)", tags: ["ok", 3, null] } }),
              "garbage",
            ],
          }),
        ],
      }),
    ])!;
    const cards = groups[0]!.cards;
    expect(cards.map((c) => c.partnerId)).toEqual([101, 9]);
    expect(cards[0]).toMatchObject({ logoUrl: null, openingHours: null, description: null, tags: [] });
    expect(cards[1]).toMatchObject({ logoUrl: null, websiteUrl: null, tags: ["ok"] });
  });

  it("uses the LAST completed find_partners call when a message has several", () => {
    const first = toolPart({ kind: "results", results: [result({ request: { city: "A", sport: "S1" } })] }, { toolCallId: "c1" });
    const second = toolPart({ kind: "results", results: [result({ request: { city: "B", sport: "S2" } })] }, { toolCallId: "c2" });
    expect(extractPartnerCards([first, second])![0]!.label).toBe("S2 in Bochum");
  });
});

describe("shapes that must yield nothing", () => {
  it("the live Supabase agent's output (no `kind`)", () => {
    const live = { needsClarification: false, batch: { requested: 1, executed: 1, deferred: 0, failed: 0 }, searches: [{ index: 0, status: "ok", built: { recommendations: [rec()] } }], renderedText: "…" };
    expect(extractPartnerCards([toolPart(live)])).toBeNull();
  });

  it("an overload refusal", () => {
    expect(extractPartnerCards([toolPart({ kind: "overload", overload: { requested: 9, limit: 4 }, renderedText: "…" })])).toBeNull();
  });

  it("a call that has not finished, failed, or belongs to another tool", () => {
    expect(extractPartnerCards([toolPart(undefined, { state: "input-available" })])).toBeNull();
    expect(extractPartnerCards([toolPart(undefined, { state: "output-error", errorText: "boom" })])).toBeNull();
    expect(extractPartnerCards([toolPart(V2_OUTPUT, { toolName: "get_partner_details" })])).toBeNull();
  });

  it("a text-only message, and a results output with no ok request", () => {
    expect(extractPartnerCards([{ type: "text", text: "Hallo" }])).toBeNull();
    expect(extractPartnerCards([toolPart({ kind: "results", results: [result({ status: "no_results", recommendations: [] })] })])).toBeNull();
    expect(extractPartnerCards([])).toBeNull();
  });
});
