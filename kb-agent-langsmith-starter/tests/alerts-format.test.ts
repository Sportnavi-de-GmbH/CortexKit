import { describe, it, expect } from "vitest";
import { fmtRuleValue, kindLabel, severityTone, ruleLabel, ruleScopeLabel, humanRuleLabel, humanErroredLabel, humanDelivery, humanRuleValue, humanRuleThreshold, humanRuleNote } from "../components/monitoring/alerts-format";

describe("alerts dashboard formatters", () => {
  it("values", () => {
    expect(fmtRuleValue("failure_rate", "0.15")).toBe("15 %");
    expect(fmtRuleValue("latency_p95", 8400)).toBe("8,4 s");
    expect(fmtRuleValue("cost_daily", "1.6")).toBe("1,60 $");
    expect(fmtRuleValue("error_repeat", 6)).toBe("6×");
    expect(fmtRuleValue("failure_rate", null)).toBe("—");
    expect(fmtRuleValue("unknown_key", 1)).toBe("—");
  });
  it("labels and tones", () => {
    expect(kindLabel("fired")).toBe("Alarm");
    expect(kindLabel("digest")).toBe("Statusbericht");
    expect(severityTone("fired", "alert")).toBe("red");
    expect(severityTone("fired", "warning")).toBe("warn");
    expect(severityTone("recovered", "alert")).toBe("green");
    expect(severityTone("digest", null)).toBe("muted");
    expect(ruleLabel("error_repeat", "total", "azure_429")).toBe("Wiederholter Fehler azure_429 · Gesamt");
  });
  it("scope labels", () => {
    expect(ruleScopeLabel("failure_rate", "all")).toBe("Fehlerrate · Alle Agenten");
    expect(ruleScopeLabel("latency_p95", "faq")).toBe("Antwortzeit p95 · FAQ");
  });
  it("human labels for the feed and the run report", () => {
    expect(humanRuleLabel("failure_rate", "faq", "")).toBe("Fehlerrate des FAQ-Assistenten");
    expect(humanRuleLabel("latency_p95", null, "")).toBe("Antwortzeit beider Assistenten");
    expect(humanErroredLabel("failure_rate·faq")).toBe("Fehlerrate (FAQ-Assistent)");
  });
});

describe("human values for the run report", () => {
  it("never shows a multiplier, the sentinel or a compact count", () => {
    expect(humanRuleValue("cost_spike", 3.2)).toBe("3,2-mal so hoch wie an einem normalen Tag");
    expect(humanRuleValue("cost_spike", 999)).toBe("deutlich mehr als an einem normalen Tag");
    expect(humanRuleThreshold("cost_spike", 3)).toBe("3-mal so hoch wie an einem normalen Tag");
    expect(humanRuleValue("error_repeat", 7)).toBe("7-mal");
    expect(humanRuleThreshold("error_repeat", 5)).toBe("5-mal");
    expect(humanRuleValue("failure_rate", "0.15")).toBe("15 %");
    expect(humanRuleValue("failure_rate", null)).toBe("—");
    expect(humanRuleValue("unknown_key", 1)).toBe("—");
  });
  it("translates an engineer note and drops one it does not know", () => {
    expect(humanRuleNote("zu wenig Daten (0 < 10)")).toBe("Zu wenige Anfragen im Zeitraum, um das zuverlässig zu beurteilen");
    expect(humanRuleNote("im Fenster nicht mehr aufgetreten")).toBe("Im Zeitraum nicht mehr aufgetreten");
    expect(humanRuleNote("etwas ganz anderes")).toBeNull();
    expect(humanRuleNote(undefined)).toBeNull();
  });
});

describe("humanDelivery", () => {
  it("says what happened, keeping the raw status as a detail", () => {
    expect(humanDelivery("sent")).toEqual({ text: "Zugestellt", tone: "good" });
    expect(humanDelivery("skipped")).toEqual({ text: "Nicht gesendet (nicht eingerichtet)", tone: "muted" });
    expect(humanDelivery("skipped: deadline")).toEqual({ text: "Nicht gesendet (Zeit abgelaufen)", tone: "muted", detail: "skipped: deadline" });
    expect(humanDelivery("failed: HTTP 403: forbidden")).toEqual({ text: "Zustellung fehlgeschlagen", tone: "bad", detail: "failed: HTTP 403: forbidden" });
    expect(humanDelivery("weird")).toEqual({ text: "Unbekannter Status", tone: "muted", detail: "weird" });
  });
});
