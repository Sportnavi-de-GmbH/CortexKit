import { describe, it, expect } from "vitest";
import { RulePatchSchema, SettingsPatchSchema, parseEventFilters } from "../lib/monitoring/alerts/query";

describe("alert patch schemas", () => {
  it("accepts a threshold change and rejects junk", () => {
    expect(RulePatchSchema.safeParse({ threshold: 0.2 }).success).toBe(true);
    expect(RulePatchSchema.safeParse({ threshold: -1 }).success).toBe(false);
    expect(RulePatchSchema.safeParse({ window_hours: 0 }).success).toBe(false);
    expect(RulePatchSchema.safeParse({ key: "cost_daily" }).success).toBe(true); // unknown keys ignored, not applied
    expect(Object.keys(RulePatchSchema.parse({ key: "x", enabled: false }))).toEqual(["enabled"]);
  });
  it("recipients must be emails", () => {
    expect(SettingsPatchSchema.safeParse({ email_recipients: ["a@b.de"] }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ email_recipients: ["nope"] }).success).toBe(false);
  });
  it("event filters", () => {
    expect(parseEventFilters(new URLSearchParams("kind=fired&agent=faq&limit=10"))).toEqual({ kind: "fired", agent: "faq", limit: 10 });
    expect(parseEventFilters(new URLSearchParams("kind=bogus&limit=999"))).toEqual({ limit: 100 });
  });
});
