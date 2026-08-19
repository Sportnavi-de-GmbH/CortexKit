import { afterEach, describe, expect, it, vi } from "vitest";
import tool from "../agent/tools/provide_booking_link.ts";

describe("provide_booking_link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured URL when BOOKING_URL is set", async () => {
    vi.stubEnv("BOOKING_URL", "https://calendly.com/sportnavi/demo");

    const result = await tool.execute({}, {} as never);

    expect(result).toEqual({
      available: true,
      bookingUrl: "https://calendly.com/sportnavi/demo",
    });
  });

  it("trims surrounding whitespace from BOOKING_URL", async () => {
    vi.stubEnv("BOOKING_URL", "  https://calendly.com/sportnavi/demo  ");

    const result = await tool.execute({}, {} as never);

    expect(result.bookingUrl).toBe("https://calendly.com/sportnavi/demo");
  });

  it("degrades to available: false — never throws — when BOOKING_URL is unset", async () => {
    vi.stubEnv("BOOKING_URL", "");

    const result = await tool.execute({}, {} as never);

    expect(result).toEqual({ available: false });
  });

  it("has a routing description with an explicit NICHT clause", () => {
    // Mirrors the assertion agent-graph.test.ts makes on the faq subagent's
    // description (tests/agent-graph.test.ts) — the description is the API,
    // and routing regressions almost always trace to a missing negative clause.
    expect(tool.description.length).toBeGreaterThan(60);
    expect(tool.description).toMatch(/NICHT/);
  });

  it("carries no approval gate — unlike request_human_contact", () => {
    // Confirms the design decision (spec §2): this is read-only with no
    // consequential action, so it must never gain an approval() call.
    expect(tool.approval).toBeUndefined();
  });
});
