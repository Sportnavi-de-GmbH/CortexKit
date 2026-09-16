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
  /** Optional key/value rows (Adaptive Card FactSet; a small table in email). */
  facts?: { title: string; value: string }[];
  /** Label for the permalink (default "Open in Langfuse"). */
  linkLabel?: string;
  /** Technical rows, kept apart from the human text (rule key, agent, raw value, ...). */
  techFacts?: { title: string; value: string }[];
  /** Heading shown above `techFacts` (e.g. "Für das Technik-Team"). */
  techLabel?: string;
  /**
   * German, human severity word ("Alarm", "Warnung", "Entwarnung / alles in Ordnung").
   * Set by the monitoring alerts only; the Langfuse relay leaves it undefined and keeps its
   * byte-identical English chrome. Every renderer prefers it over `severityLabel` when present,
   * and treats its presence as "this message is read by the Sportnavi team" — the ISO
   * timestamp then moves into the technical block.
   */
  humanSeverity?: string;
}

/** ALERT → "Alarm": the word the team reads, not the enum. */
export const HUMAN_SEVERITY: Record<AlertMessage["severity"], string> = {
  ALERT: "Alarm",
  WARNING: "Warnung",
  OK: "Entwarnung / alles in Ordnung",
  NO_DATA: "Keine Daten",
  PAUSED: "Pausiert",
  UNKNOWN: "Unbekannt",
};

/** "15.09. 10:30" — a time a human reads, not an ISO string. */
function humanTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The technical rows as rendered: for a human-facing message the ISO time joins them. */
function techRowsOf(msg: AlertMessage): { title: string; value: string }[] {
  const rows = [...(msg.techFacts ?? [])];
  if (msg.humanSeverity) rows.push({ title: "Zeitpunkt", value: msg.timestampIso });
  return rows;
}

/** The small grey line at the bottom of a card/email. */
function footerOf(msg: AlertMessage): string {
  return msg.humanSeverity ? humanTime(msg.timestampIso) : `${msg.timestampIso} · window ${msg.window}`;
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
  const techFacts = techRowsOf(msg);
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: `${msg.severityEmoji} ${msg.humanSeverity ?? msg.severityLabel} — ${msg.projectLabel}`,
      wrap: true,
    },
    { type: "TextBlock", weight: "Bolder", text: msg.title, wrap: true },
    { type: "TextBlock", text: msg.detail, wrap: true },
  ];
  if (msg.facts && msg.facts.length > 0) {
    body.push({ type: "FactSet", facts: msg.facts.map((f) => ({ title: f.title, value: f.value })) });
  }
  if (techFacts.length > 0) {
    body.push({ type: "TextBlock", size: "Small", isSubtle: true, text: msg.techLabel ?? "Technische Details", wrap: true });
    body.push({ type: "FactSet", facts: techFacts.map((f) => ({ title: f.title, value: f.value })) });
  }
  if (msg.permalink) {
    body.push({ type: "TextBlock", text: `[${msg.linkLabel ?? "Open in Langfuse"}](${msg.permalink})`, wrap: true });
  }
  body.push({ type: "TextBlock", text: footerOf(msg), isSubtle: true, wrap: true });

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
  if (msg.humanSeverity) return `[Navio] ${msg.humanSeverity}: ${msg.title}`;
  return `[${msg.projectLabel}] ${msg.severityLabel}: ${msg.title}`;
}

export function formatEmailHtml(msg: AlertMessage): string {
  const techFacts = techRowsOf(msg);
  const link = msg.permalink
    ? `<p><a href="${escapeHtml(msg.permalink)}">${escapeHtml(msg.linkLabel ?? "Open in Langfuse")}</a></p>`
    : "";
  return [
    `<p>${msg.severityEmoji} <strong>${escapeHtml(msg.humanSeverity ?? msg.severityLabel)}</strong> — ${escapeHtml(msg.projectLabel)}</p>`,
    `<p><strong>${escapeHtml(msg.title)}</strong></p>`,
    `<p>${escapeHtml(msg.detail)}</p>`,
    msg.facts && msg.facts.length > 0
      ? `<table style="border-collapse:collapse;font-size:13px">${msg.facts.map((f) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(f.title)}</td><td style="padding:2px 0">${escapeHtml(f.value)}</td></tr>`).join("")}</table>`
      : "",
    techFacts.length > 0
      ? `<p>${escapeHtml(msg.techLabel ?? "Technische Details")}</p>
<table style="border-collapse:collapse;font-size:13px">${techFacts.map((f) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(f.title)}</td><td style="padding:2px 0">${escapeHtml(f.value)}</td></tr>`).join("")}</table>`
      : "",
    link,
    `<p style="color:#666;font-size:12px">${escapeHtml(footerOf(msg))}</p>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatEmailText(msg: AlertMessage): string {
  const techFacts = techRowsOf(msg);
  const lines = [
    `${msg.humanSeverity ?? msg.severityLabel} — ${msg.projectLabel}`,
    msg.title,
    msg.detail,
    ...(msg.facts ?? []).map((f) => `${f.title}: ${f.value}`),
  ];
  if (techFacts.length > 0) {
    lines.push(msg.techLabel ?? "Technische Details", ...techFacts.map((f) => `${f.title}: ${f.value}`));
  }
  if (msg.permalink) lines.push(`${msg.linkLabel ?? "Open in Langfuse"}: ${msg.permalink}`);
  lines.push(footerOf(msg));
  return lines.join("\n\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
