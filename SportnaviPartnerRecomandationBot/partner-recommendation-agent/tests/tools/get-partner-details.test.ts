import { describe, expect, it } from "vitest";
import { getPartnerDetails } from "../../lib/partners/get-partner-details";
import { fakeSupabase } from "./_fakes";

describe("getPartnerDetails", () => {
  it("returns the mapped profile when found", async () => {
    const supabase = fakeSupabase({
      rpc: {
        get_partner_profiles: {
          data: [
            {
              partner_id: 15439,
              title: "Kletterzentrum Neoliet - Bochum",
              city: "Bochum",
              llm_profile: "Ort: Bochum\nAdresse: ...",
            },
          ],
          error: null,
        },
      },
    });

    const details = await getPartnerDetails({ partnerId: 15439 }, supabase);

    expect(details).toEqual({
      partnerId: 15439,
      name: "Kletterzentrum Neoliet - Bochum",
      city: "Bochum",
      llmProfile: "Ort: Bochum\nAdresse: ...",
    });
    expect(supabase.rpcCalls[0]).toEqual({
      name: "get_partner_profiles",
      args: { p_ids: [15439] },
    });
  });

  it("returns null for an unknown or inactive partner id (honest-unknown)", async () => {
    const supabase = fakeSupabase({
      rpc: { get_partner_profiles: { data: [], error: null } },
    });

    const details = await getPartnerDetails({ partnerId: 999999 }, supabase);

    expect(details).toBeNull();
  });

  it("throws a clear error when the RPC errors", async () => {
    const supabase = fakeSupabase({
      rpc: { get_partner_profiles: { data: null, error: { message: "boom" } } },
    });

    await expect(getPartnerDetails({ partnerId: 1 }, supabase)).rejects.toThrow(/boom/);
  });

  it("applies a supplied AbortSignal to the get_partner_profiles RPC call", async () => {
    const supabase = fakeSupabase({
      rpc: { get_partner_profiles: { data: [], error: null } },
    });
    const controller = new AbortController();
    await getPartnerDetails({ partnerId: 1 }, supabase, controller.signal);

    const abortCalls = supabase.methodCalls.filter((c: any) => c.method === "abortSignal");
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].args[0]).toBe(controller.signal);
  });
});
