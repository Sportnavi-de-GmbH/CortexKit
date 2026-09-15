import { describe, it, expect } from "vitest";
import { fmtRuleValue, kindLabel, severityTone, ruleLabel } from "../components/monitoring/alerts-format";

describe("alerts dashboard formatters", () => {
  it("values", () => {
    expect(fmtRuleValue("failure_rate", "0.15")).toBe("15 %");
    expect(fmtRuleValue("latency_p95", 8400)).toBe("8,4 s");
    expect(fmtRuleValue("cost_daily", "1.6")).toBe("1,60 $");
    expect(fmtRuleValue("error_repeat", 6)).toBe("6×");
    expect(fmtRuleValue("failure_rate", null)).toBe("—");
  });
  it("labels and tones", () => {
    expect(kindLabel("fired")).toBe("Alarm");
    expect(severityTone("fired", "alert")).toBe("red");
    expect(severityTone("fired", "warning")).toBe("warn");
    expect(severityTone("recovered", "alert")).toBe("green");
    expect(severityTone("digest", null)).toBe("muted");
    expect(ruleLabel("error_repeat", "total", "azure_429")).toBe("Wiederholter Fehler azure_429 · Gesamt");
  });
});
