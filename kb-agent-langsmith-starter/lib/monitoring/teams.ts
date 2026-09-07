// Microsoft Teams delivery via a "Workflows" incoming webhook (the modern replacement
// for retired Office 365 Connectors — learn.microsoft.com/microsoftteams/platform/
// webhooks-and-connectors/how-to/add-incoming-webhook). POSTs an Adaptive Card
// `attachments` envelope. The earlier plain `{"text": ...}` schema was DISPROVEN LIVE
// (2026-08-21) against the real "Webhookbenachrichtigungen an einen Kanal senden"
// Workflow: it returns 202 but the flow posts nothing, because the template iterates
// over Adaptive Card attachments. Do not "simplify" back to the text schema.
//
// App-only Graph posting to a channel (ChannelMessage.Send) was considered and rejected:
// verified live against learn.microsoft.com/graph/api/channel-post-messages that
// Application permission for that endpoint is restricted to the message-MIGRATION API
// (Teamwork.Migrate.All), not live posting.

import { formatTeamsCard, type AlertMessage } from "./format-alert";

const TIMEOUT_MS = 10_000;

export function teamsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TEAMS_ALERT_WEBHOOK_URL ?? "").trim() !== "";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

/** Langfuse retries the RELAY, not our downstream calls (the relay always 200s Langfuse —
 *  see lib/monitoring/relay.ts), so this is the only safety net a transient Teams-side
 *  blip gets: one retry on network error / 5xx, none on 4xx (a config problem, not
 *  transient). */
export async function sendTeamsAlert(
  msg: AlertMessage,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<SendResult> {
  const env = deps.env ?? process.env;
  const url = (env.TEAMS_ALERT_WEBHOOK_URL ?? "").trim();
  if (!url) return { ok: false, detail: "not configured" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  const body = JSON.stringify(formatTeamsCard(msg));

  for (const attempt of [1, 2] as const) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
        fetchImpl,
      );
    } catch (e) {
      if (attempt === 1) continue;
      return { ok: false, detail: `transport error: ${(e as Error).message}` };
    }
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    if (res.status >= 500 && attempt === 1) continue; // one retry on a transient failure
    const text = await res.text().catch(() => "");
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  return { ok: false, detail: "unreachable" };
}
