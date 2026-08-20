/**
 * CONVEX PORT of the Supabase build's get-partners-by-city test.
 *
 * Several of the original assertions checked PostgREST mechanics — that
 * `.select()` never named email/phone, that `.eq("is_active", true)` was
 * added, that `.overlaps("tags_norm", …)` fired only for a non-empty filter,
 * that `.abortSignal()` was applied to BOTH queries. All of that logic moved
 * server-side into convex/partners.ts:getPartnersByCity, so the equivalent
 * assertion here is on the ARGUMENTS handed to the backend, plus the shape of
 * what comes back. The behavioural guarantees being pinned are unchanged.
 */
import { describe, expect, it } from "vitest";
import { getPartnersByCity } from "../../lib/partners/get-partners-by-city";
import { fakeConvex, partnerRow } from "./_fakes";

const rowKoeln = partnerRow({ id: 1, name: "Kletterhalle Köln", city: "Köln" });
const rowKoelnDup = partnerRow({ id: 1, name: "Kletterhalle Köln", city: "Koeln" }); // same id, other alias spelling
const rowKoeln2 = partnerRow({ id: 2, name: "Yogastudio Köln", city: "Köln" });

describe("getPartnersByCity", () => {
  it("returns [] without querying when aliases is empty (E2)", async () => {
    const convex = fakeConvex();
    const rows = await getPartnersByCity({ aliases: [] }, convex);
    expect(rows).toEqual([]);
    expect(convex.calls).toHaveLength(0);
  });

  it("dedupes by id across overlapping aliases (E8)", async () => {
    const convex = fakeConvex({ getPartnersByCity: [rowKoeln, rowKoelnDup, rowKoeln2] });
    const rows = await getPartnersByCity({ aliases: ["Köln", "Koeln"] }, convex);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("passes every alias through so the backend can match all spellings", async () => {
    const convex = fakeConvex({ getPartnersByCity: [rowKoeln] });
    await getPartnersByCity({ aliases: ["Köln", "Koeln"] }, convex);
    expect(convex.callsTo("getPartnersByCity")[0]!.args).toMatchObject({
      aliases: ["Köln", "Koeln"],
    });
  });

  it("returns every matched row unranked and untrimmed — no limit (golden rule)", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      partnerRow({ id: i, name: `P${i}`, city: "Köln" }),
    );
    const convex = fakeConvex({ getPartnersByCity: many });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, convex);
    expect(rows).toHaveLength(50);
  });

  it("forwards tagFilter only when provided and non-empty", async () => {
    const convex = fakeConvex({ getPartnersByCity: [rowKoeln] });

    await getPartnersByCity({ aliases: ["Köln"] }, convex);
    expect(convex.callsTo("getPartnersByCity")[0]!.args).not.toHaveProperty("tagFilter");

    // An empty array is "not provided" for filtering purposes — forwarding it
    // would make the backend apply an overlap filter that matches nothing.
    await getPartnersByCity({ aliases: ["Köln"], tagFilter: [] }, convex);
    expect(convex.callsTo("getPartnersByCity")[1]!.args).not.toHaveProperty("tagFilter");

    await getPartnersByCity({ aliases: ["Köln"], tagFilter: ["klettern"] }, convex);
    expect(convex.callsTo("getPartnersByCity")[2]!.args).toMatchObject({
      tagFilter: ["klettern"],
    });
  });

  it("carries quality_score through from the backend's best-effort join", async () => {
    const convex = fakeConvex({
      getPartnersByCity: [partnerRow({ ...rowKoeln, quality_score: 0.75 })],
    });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, convex);
    expect(rows[0]!.quality_score).toBe(0.75);
  });

  it("leaves is_active filtering to the backend by default, and forwards includeInactive (E18)", async () => {
    const convex = fakeConvex({ getPartnersByCity: [rowKoeln] });

    await getPartnersByCity({ aliases: ["Köln"] }, convex);
    expect(convex.callsTo("getPartnersByCity")[0]!.args).not.toHaveProperty("includeInactive");

    await getPartnersByCity({ aliases: ["Köln"], includeInactive: true }, convex);
    expect(convex.callsTo("getPartnersByCity")[1]!.args).toMatchObject({
      includeInactive: true,
    });
  });

  it("still returns partners with no coordinates as home partners (E17)", async () => {
    // Coordinates are not part of the projection this path selects at all —
    // find-nearby-cities.ts runs its own separate query for them — so a
    // partner without them is indistinguishable here, which is the point.
    const noCoords = partnerRow({ id: 3, name: "Studio Ohne Koordinaten", city: "Köln" });
    const convex = fakeConvex({ getPartnersByCity: [noCoords] });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, convex);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(3);
  });

  it("never returns PII (email/phone) — contact info only reaches context via llm_profile", async () => {
    // convex/partners.ts:getPartnersByCity does not select those columns; this
    // asserts the client half of the same invariant, so a future widening of
    // the server projection cannot leak them into PartnerRow unnoticed.
    const convex = fakeConvex({
      getPartnersByCity: [
        { ...rowKoeln, email: "leak@example.com", phone: "+49123" } as never,
      ],
    });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, convex);

    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect("email" in row).toBe(false);
      expect("phone" in row).toBe(false);
    }
  });

  it("applies the given AbortSignal to the backend call when supplied", async () => {
    const convex = fakeConvex({ getPartnersByCity: [rowKoeln] });
    const controller = new AbortController();
    await getPartnersByCity({ aliases: ["Köln"] }, convex, { signal: controller.signal });

    // ONE call now, not two: the partner_intelligence join moved server-side.
    const calls = convex.callsTo("getPartnersByCity");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("passes no signal when none is supplied", async () => {
    const convex = fakeConvex({ getPartnersByCity: [rowKoeln] });
    await getPartnersByCity({ aliases: ["Köln"] }, convex);
    expect(convex.callsTo("getPartnersByCity")[0]!.signal).toBeUndefined();
  });
});
