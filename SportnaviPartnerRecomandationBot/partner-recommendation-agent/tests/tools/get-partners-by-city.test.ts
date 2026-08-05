import { describe, expect, it } from "vitest";
import { getPartnersByCity } from "../../lib/partners/get-partners-by-city";
import { fakeSupabase } from "./_fakes";

const rowKoeln = { id: 1, name: "Kletterhalle Köln", city: "Köln", is_active: true };
const rowKoelnDup = { id: 1, name: "Kletterhalle Köln", city: "Koeln", is_active: true }; // same id, other alias spelling
const rowKoeln2 = { id: 2, name: "Yogastudio Köln", city: "Köln", is_active: true };

describe("getPartnersByCity", () => {
  it("returns [] without querying when aliases is empty (E2)", async () => {
    const supabase = fakeSupabase({});
    const rows = await getPartnersByCity({ aliases: [] }, supabase);
    expect(rows).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("dedupes by id across overlapping aliases (E8)", async () => {
    const supabase = fakeSupabase({
      from: {
        partners: { data: [rowKoeln, rowKoelnDup, rowKoeln2], error: null },
        partner_intelligence: { data: [], error: null },
      },
    });
    const rows = await getPartnersByCity({ aliases: ["Köln", "Koeln"] }, supabase);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("returns every matched row unranked and untrimmed — no limit (golden rule)", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `P${i}`, city: "Köln", is_active: true }));
    const supabase = fakeSupabase({
      from: { partners: { data: many, error: null }, partner_intelligence: { data: [], error: null } },
    });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, supabase);
    expect(rows).toHaveLength(50);
  });

  it("applies tagFilter only when provided and non-empty", async () => {
    const supabase = fakeSupabase({
      from: { partners: { data: [rowKoeln], error: null }, partner_intelligence: { data: [], error: null } },
    });

    await getPartnersByCity({ aliases: ["Köln"] }, supabase);
    const overlapsAfterNoFilter = supabase.methodCalls.filter((c: any) => c.method === "overlaps").length;
    expect(overlapsAfterNoFilter).toBe(0);

    await getPartnersByCity({ aliases: ["Köln"], tagFilter: [] }, supabase);
    const overlapsAfterEmptyFilter = supabase.methodCalls.filter((c: any) => c.method === "overlaps").length;
    expect(overlapsAfterEmptyFilter).toBe(0); // empty array is "not provided" for filtering purposes

    await getPartnersByCity({ aliases: ["Köln"], tagFilter: ["klettern"] }, supabase);
    const overlapsCalls = supabase.methodCalls.filter((c: any) => c.method === "overlaps");
    expect(overlapsCalls).toHaveLength(1);
    expect(overlapsCalls[0].args).toEqual(["tags_norm", ["klettern"]]);
  });

  it("best-effort joins quality_score from partner_intelligence", async () => {
    const supabase = fakeSupabase({
      from: {
        partners: { data: [rowKoeln], error: null },
        partner_intelligence: { data: [{ partner_id: 1, quality_score: 0.75 }], error: null },
      },
    });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, supabase);
    expect(rows[0].quality_score).toBe(0.75);
  });

  it("filters is_active=true by default, and includeInactive bypasses the filter (E18)", async () => {
    const supabase = fakeSupabase({
      from: {
        partners: { data: [rowKoeln], error: null },
        partner_intelligence: { data: [], error: null },
      },
    });

    await getPartnersByCity({ aliases: ["Köln"] }, supabase);
    const eqCallsDefault = supabase.methodCalls.filter(
      (c: any) => c.table === "partners" && c.method === "eq",
    );
    expect(eqCallsDefault).toContainEqual({
      table: "partners",
      method: "eq",
      args: ["is_active", true],
    });

    await getPartnersByCity({ aliases: ["Köln"], includeInactive: true }, supabase);
    const eqCallsAfterInactive = supabase.methodCalls.filter(
      (c: any) => c.table === "partners" && c.method === "eq" && c.args[0] === "is_active",
    );
    // Still only the one call from the first (default) invocation above —
    // the includeInactive:true call must NOT add another is_active filter.
    expect(eqCallsAfterInactive).toHaveLength(1);
  });

  it("still returns partners with no coordinates as home partners (E17)", async () => {
    const noCoords = { id: 3, name: "Studio Ohne Koordinaten", city: "Köln", is_active: true, latitude: null, longitude: null };
    const supabase = fakeSupabase({
      from: {
        partners: { data: [noCoords], error: null },
        partner_intelligence: { data: [], error: null },
      },
    });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, supabase);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(3);
    expect(rows[0].latitude).toBeNull();
    expect(rows[0].longitude).toBeNull();
  });

  it("never selects or returns PII (email/phone) — contact info only reaches context via llm_profile", async () => {
    const supabase = fakeSupabase({
      from: {
        partners: { data: [rowKoeln], error: null },
        partner_intelligence: { data: [], error: null },
      },
    });
    const rows = await getPartnersByCity({ aliases: ["Köln"] }, supabase);

    // The select() call itself must never request email/phone columns.
    const selectCalls = supabase.methodCalls.filter((c: any) => c.table === "partners" && c.method === "select");
    expect(selectCalls).toHaveLength(1);
    const selectedColumns = String(selectCalls[0].args[0]);
    expect(selectedColumns).not.toMatch(/\bemail\b/);
    expect(selectedColumns).not.toMatch(/\bphone\b/);

    // And no returned row carries those keys, even implicitly.
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect("email" in row).toBe(false);
      expect("phone" in row).toBe(false);
    }
  });

  it("applies the given AbortSignal to both the partners and partner_intelligence queries when supplied", async () => {
    const supabase = fakeSupabase({
      from: {
        partners: { data: [rowKoeln], error: null },
        partner_intelligence: { data: [], error: null },
      },
    });
    const controller = new AbortController();
    await getPartnersByCity({ aliases: ["Köln"] }, supabase, { signal: controller.signal });

    const abortCalls = supabase.methodCalls.filter((c: any) => c.method === "abortSignal");
    expect(abortCalls).toHaveLength(2); // one per query (partners, partner_intelligence)
    for (const call of abortCalls) expect(call.args[0]).toBe(controller.signal);
  });

  it("never calls abortSignal when no signal is supplied", async () => {
    const supabase = fakeSupabase({
      from: {
        partners: { data: [rowKoeln], error: null },
        partner_intelligence: { data: [], error: null },
      },
    });
    await getPartnersByCity({ aliases: ["Köln"] }, supabase);
    expect(supabase.methodCalls.some((c: any) => c.method === "abortSignal")).toBe(false);
  });
});
