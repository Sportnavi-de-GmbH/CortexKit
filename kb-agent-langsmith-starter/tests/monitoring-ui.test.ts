import { describe, it, expect } from "vitest";
import { fmtMs, fmtUsd, fmtTime, fmtInt } from "../components/monitoring/format";

describe("dashboard formatters", () => {
  it("durations", () => {
    expect(fmtMs(850)).toBe("850 ms");
    expect(fmtMs(4800)).toBe("4.8 s");
    expect(fmtMs(61000)).toBe("1:01 min");
    expect(fmtMs(null)).toBe("—");
  });
  it("money (numeric columns arrive as strings from Postgres)", () => {
    expect(fmtUsd(0.0021)).toBe("$0.0021");
    expect(fmtUsd("0.003546")).toBe("$0.0035");
    expect(fmtUsd(0)).toBe("$0.0000");
    expect(fmtUsd(null)).toBe("—");
  });
  it("time and ints", () => {
    expect(fmtTime("2026-09-14T08:42:07.000Z")).toMatch(/^\d{2}\.\d{2}\. \d{2}:\d{2}:\d{2}$/);
    expect(fmtInt(1234)).toBe("1,234");
    expect(fmtInt(undefined)).toBe("—");
  });
});
