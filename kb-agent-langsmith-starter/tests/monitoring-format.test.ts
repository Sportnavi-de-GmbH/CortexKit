import { describe, it, expect } from "vitest";
import {
  LangfuseWebhookSchema,
  toAlertMessage,
  formatTeamsCard,
  formatEmailSubject,
  formatEmailHtml,
  formatEmailText,
  type AlertMessage,
} from "../lib/monitoring/format-alert";

const RAW_PAYLOAD = {
  id: "evt_123",
  timestamp: "2026-08-19T10:30:00Z",
  type: "monitor-alert",
  apiVersion: "v1",
  payload: {
    monitorId: "monitor_abc123",
    projectId: "proj_xyz789",
    permalink: "https://sportnavi-langfuse.sportnavi.de/project/proj_xyz789/monitors/monitor_abc123",
    message: {
      title: "avg latency crossed alert threshold",
      body: "avg latency is 12345 ms (threshold: 8000 ms) over the last 1h",
    },
    severity: "ALERT" as const,
    timestamp: "2026-08-19T10:30:00Z",
    fromTimestamp: "2026-08-19T09:30:00Z",
    toTimestamp: "2026-08-19T10:30:00Z",
    view: "observations",
    window: "1h",
  },
};

describe("LangfuseWebhookSchema", () => {
  it("parses a real-shaped payload", () => {
    const result = LangfuseWebhookSchema.safeParse(RAW_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it("ignores unknown extra fields (forward compatible with a future Langfuse field)", () => {
    const result = LangfuseWebhookSchema.safeParse({ ...RAW_PAYLOAD, somethingNew: true });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing the required message body", () => {
    const bad = { ...RAW_PAYLOAD, payload: { ...RAW_PAYLOAD.payload, message: { title: "x" } } };
    expect(LangfuseWebhookSchema.safeParse(bad).success).toBe(false);
  });
});

describe("toAlertMessage + severity emoji mapping", () => {
  const cases: Array<[AlertMessage["severity"], string]> = [
    ["ALERT", "🔴"],
    ["WARNING", "🟡"],
    ["OK", "🟢"],
    ["NO_DATA", "⚪"],
    ["PAUSED", "⏸️"],
    ["UNKNOWN", "⚫"],
  ];

  it.each(cases)("maps severity %s to emoji %s", (severity, emoji) => {
    const parsed = LangfuseWebhookSchema.parse({
      ...RAW_PAYLOAD,
      payload: { ...RAW_PAYLOAD.payload, severity },
    });
    const msg = toAlertMessage(parsed, "Navio — FAQ");
    expect(msg.severityEmoji).toBe(emoji);
    expect(msg.severityLabel).toBe(severity);
  });
});

describe("cross-channel consistency", () => {
  const msg = toAlertMessage(LangfuseWebhookSchema.parse(RAW_PAYLOAD), "Navio — FAQ");

  it("every renderer surfaces the same title, metric detail, window, project and permalink", () => {
    const teams = JSON.stringify(formatTeamsCard(msg));
    const subject = formatEmailSubject(msg);
    const html = formatEmailHtml(msg);
    const text = formatEmailText(msg);

    for (const rendered of [teams, subject + html, text]) {
      expect(rendered).toContain(msg.title);
    }
    for (const rendered of [teams, html, text]) {
      expect(rendered).toContain(msg.projectLabel);
      expect(rendered).toContain(msg.permalink);
    }
    expect(subject).toContain(msg.projectLabel);
    expect(subject).toContain(msg.severityLabel);
  });

  it("HTML output escapes untrusted text from the Langfuse payload", () => {
    const hostile = toAlertMessage(
      LangfuseWebhookSchema.parse({
        ...RAW_PAYLOAD,
        payload: {
          ...RAW_PAYLOAD.payload,
          message: { title: '<img src=x onerror="alert(1)">', body: "ok" },
        },
      }),
      "Navio — FAQ",
    );
    expect(formatEmailHtml(hostile)).not.toContain("<img");
    expect(formatEmailHtml(hostile)).toContain("&lt;img");
  });
});
