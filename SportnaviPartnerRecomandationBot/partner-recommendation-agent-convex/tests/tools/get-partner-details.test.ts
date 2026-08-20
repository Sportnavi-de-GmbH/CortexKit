import { describe, expect, it } from "vitest";
import { getPartnerDetails } from "../../lib/partners/get-partner-details";
import { fakeConvex, profileRow } from "./_fakes";

describe("getPartnerDetails", () => {
  it("returns the mapped profile when found", async () => {
    const convex = fakeConvex({
      getPartnerProfiles: [
        profileRow({
          partner_id: 15439,
          title: "Kletterzentrum Neoliet - Bochum",
          city: "Bochum",
          llm_profile: "Ort: Bochum\nAdresse: ...",
        }),
      ],
    });

    const details = await getPartnerDetails({ partnerId: 15439 }, convex);

    expect(details).toEqual({
      partnerId: 15439,
      name: "Kletterzentrum Neoliet - Bochum",
      city: "Bochum",
      llmProfile: "Ort: Bochum\nAdresse: ...",
    });
    expect(convex.callsTo("getPartnerProfiles")[0]!.args).toEqual([15439]);
  });

  it("returns null for an unknown or inactive partner id (honest-unknown)", async () => {
    const convex = fakeConvex({ getPartnerProfiles: [] });

    const details = await getPartnerDetails({ partnerId: 999999 }, convex);

    expect(details).toBeNull();
  });

  it("throws a clear error when the backend errors", async () => {
    const convex = fakeConvex({ getPartnerProfiles: new Error("boom") });

    await expect(getPartnerDetails({ partnerId: 1 }, convex)).rejects.toThrow(/boom/);
  });

  it("applies a supplied AbortSignal to the getPartnerProfiles call", async () => {
    const convex = fakeConvex({ getPartnerProfiles: [] });
    const controller = new AbortController();
    await getPartnerDetails({ partnerId: 1 }, convex, controller.signal);

    const calls = convex.callsTo("getPartnerProfiles");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(controller.signal);
  });
});
