// The one place both notification channels read from, so title/severity/metric/window/
// project/permalink can never drift between Teams and email — each channel renders the
// same AlertMessage, it never re-derives facts from the raw Langfuse payload itself.

import { z } from "zod";

/** Shape of a Langfuse "monitor-alert" webhook body — verified live against the running
 *  instance and langfuse.com/docs/metrics/features/monitors. Unknown extra fields are
 *  ignored (zod's default), so a future Langfuse field addition doesn't break parsing. */
export const LangfuseWebhookSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string(),
  type: z.string(),
  apiVersion: z.string().optional(),
  payload: z.object({
    monitorId: z.string(),
    projectId: z.string(),
    permalink: z.string().optional(),
    message: z.object({
      title: z.string(),
      body: z.string(),
    }),
    severity: z.enum(["UNKNOWN", "OK", "WARNING", "ALERT", "NO_DATA", "PAUSED"]),
    timestamp: z.string().optional(),
    fromTimestamp: z.string().optional(),
    toTimestamp: z.string().optional(),
    view: z.string().optional(),
    window: z.string().optional(),
  }),
});

export type LangfuseWebhookPayload = z.infer<typeof LangfuseWebhookSchema>;

export interface AlertMessage {
  title: string;
  detail: string;
  severity: "UNKNOWN" | "OK" | "WARNING" | "ALERT" | "NO_DATA" | "PAUSED";
  severityEmoji: string;
  severityLabel: string;
  projectLabel: string;
  window: string;
  permalink: string;
  timestampIso: string;
}

const SEVERITY_EMOJI: Record<AlertMessage["severity"], string> = {
  ALERT: "🔴",
  WARNING: "🟡",
  OK: "🟢",
  NO_DATA: "⚪",
  PAUSED: "⏸️",
  UNKNOWN: "⚫",
};

export function toAlertMessage(event: LangfuseWebhookPayload, projectLabel: string): AlertMessage {
  const { payload } = event;
  return {
    title: payload.message.title,
    detail: payload.message.body,
    severity: payload.severity,
    severityEmoji: SEVERITY_EMOJI[payload.severity],
    severityLabel: payload.severity,
    projectLabel,
    window: payload.window ?? "unknown",
    permalink: payload.permalink ?? "",
    timestampIso: payload.timestamp ?? event.timestamp,
  };
}

/** Adaptive Card envelope for the Teams Workflows webhook. Measured live 2026-08-21 against
 *  the real "Webhookbenachrichtigungen an einen Kanal senden" Workflow on the Navio Alerts
 *  channel: a plain `{"text": ...}` body is ACCEPTED (202) but posts NOTHING — the template's
 *  flow iterates over Adaptive Card attachments, so the card shape is required, not optional.
 *  TextBlock markdown covers what we need (bold, links). */
export function formatTeamsCard(msg: AlertMessage): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: `${msg.severityEmoji} ${msg.severityLabel} — ${msg.projectLabel}`,
      wrap: true,
    },
    { type: "TextBlock", weight: "Bolder", text: msg.title, wrap: true },
    { type: "TextBlock", text: msg.detail, wrap: true },
  ];
  if (msg.permalink) {
    body.push({ type: "TextBlock", text: `[Open in Langfuse](${msg.permalink})`, wrap: true });
  }
  body.push({ type: "TextBlock", text: `${msg.timestampIso} · window ${msg.window}`, isSubtle: true, wrap: true });

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
        },
      },
    ],
  };
}

export function formatEmailSubject(msg: AlertMessage): string {
  return `[${msg.projectLabel}] ${msg.severityLabel}: ${msg.title}`;
}

export function formatEmailHtml(msg: AlertMessage): string {
  const link = msg.permalink
    ? `<p><a href="${escapeHtml(msg.permalink)}">Open in Langfuse</a></p>`
    : "";
  return [
    `<p>${msg.severityEmoji} <strong>${escapeHtml(msg.severityLabel)}</strong> — ${escapeHtml(msg.projectLabel)}</p>`,
    `<p><strong>${escapeHtml(msg.title)}</strong></p>`,
    `<p>${escapeHtml(msg.detail)}</p>`,
    link,
    `<p style="color:#666;font-size:12px">${escapeHtml(msg.timestampIso)} · window ${escapeHtml(msg.window)}</p>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatEmailText(msg: AlertMessage): string {
  const lines = [
    `${msg.severityLabel} — ${msg.projectLabel}`,
    msg.title,
    msg.detail,
  ];
  if (msg.permalink) lines.push(`Open in Langfuse: ${msg.permalink}`);
  lines.push(`${msg.timestampIso} · window ${msg.window}`);
  return lines.join("\n\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
