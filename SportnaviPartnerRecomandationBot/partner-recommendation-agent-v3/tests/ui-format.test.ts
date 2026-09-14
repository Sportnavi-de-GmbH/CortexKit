import { describe, expect, it } from "vitest";
import { fmtKm, fmtScore, statusColor } from "../lib/ui/format";
describe("ui format", () => {
  it("formats", () => {
    expect(fmtScore(0.83)).toBe("0.8300"); expect(fmtScore(null)).toBe("—");
    expect(fmtKm(0)).toBe("0 km"); expect(fmtKm(17.26)).toBe("17.3 km");
    expect(statusColor("error")).toMatch(/red/); expect(statusColor("skipped")).toMatch(/zinc/);
    expect(statusColor("partial")).toMatch(/amber/);
  });
});
