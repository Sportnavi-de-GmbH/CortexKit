import { describe, expect, it } from "vitest";
import { getPartnerDetails } from "../../lib/partners/get-partner-details";
import { fakeSupabase, profileRow } from "./_fakes";

describe("getPartnerDetails", () => {
  it("returns the mapped profile when found", async () => {
    const supabase = fakeSupabase({
      getPartnerProfiles: [
        profileRow({
          partner_id: 15439,
          title: "Kletterzentrum Neoliet - Bochum",
          city: "Bochum",
          llm_profile: "Ort: Bochum\nAdresse: ...",
        }),
      ],
    });

    const details = await getPartnerDetails({ partnerId: 15439 }, supabase);

    expect(details).toEqual({
      partnerId: 15439,
      name: "Kletterzentrum Neoliet - Bochum",
      city: "Bochum",
      llmProfile: "Ort: Bochum\nAdresse: ...",
    });
    expect(supabase.callsTo("getPartnerProfiles")[0]!.args).toEqual([15439]);
  });

  it("returns null for an unknown or inactive partner id (honest-unknown)", async () => {
    const supabase = fakeSupabase({ getPartnerProfiles: [] });

    const details = await getPartnerDetails({ partnerId: 999999 }, supabase);

    expect(details).toBeNull();
  });

  it("throws a clear error when the backend errors", async () => {
    const supabase = fakeSupabase({ getPartnerProfiles: new Error("boom") });

    await expect(getPartnerDetails({ partnerId: 1 }, supabase)).rejects.toThrow(/boom/);
  });

  it("applies a supplied AbortSignal to the getPartnerProfiles call", async () => {
    const supabase = fakeSupabase({ getPartnerProfiles: [] });
    const controller = new AbortController();
    await getPartnerDetails({ partnerId: 1 }, supabase, controller.signal);

    const calls = supabase.callsTo("getPartnerProfiles");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(controller.signal);
  });
});
