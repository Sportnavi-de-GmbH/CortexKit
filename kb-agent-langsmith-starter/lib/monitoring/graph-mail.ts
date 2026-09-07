// Email delivery via Microsoft Graph's sendMail — SERVER ONLY.
//
// Reuses the org's existing "navio-chatbot" Azure AD app registration (already
// admin-consented for several Graph permissions) rather than SMTP/nodemailer or a new
// vendor: just the Mail.Send APPLICATION permission, admin-consented (see
// docs/MONITORING-ALERTING.md for the exact steps). Mirrors lib/contact/salesforce.ts's
// OAuth client-credentials shape (cached token, in-flight-collapsed refresh, timeout,
// retry-once-after-401) — this repo prefers hand-rolled fetch over an SDK for these
// integrations (see lib/langfuse.ts's header comment for the same reasoning).
//
// Verified live against learn.microsoft.com/graph/api/user-sendmail: app-only sendMail
// must target /users/{id|upn}/sendMail — never /me, which requires a signed-in user that
// an unattended client-credentials flow does not have. Success is 202 Accepted with an
// EMPTY body — there is no delivery confirmation; this is fire-and-forget by design.

import { formatEmailHtml, formatEmailSubject, type AlertMessage } from "./format-alert";

const TENANT_ID = (process.env.MS_GRAPH_TENANT_ID ?? "").trim();
const CLIENT_ID = (process.env.MS_GRAPH_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.MS_GRAPH_CLIENT_SECRET ?? "").trim();
const SENDER_UPN = (process.env.MS_GRAPH_SENDER_UPN ?? "").trim();
const TIMEOUT_MS = Number(process.env.MS_GRAPH_TIMEOUT_SEC ?? 15) * 1000;
const TOKEN_TTL_SEC = 3300; // Graph tokens are typically valid 3600s; refresh a bit early

function recipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True only when the app credentials AND sender mailbox are configured. */
export function graphMailEnabled(): boolean {
  return Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET && SENDER_UPN);
}

/** True only when someone is actually configured to receive the mail. Kept separate from
 *  graphMailEnabled() so a misconfigured recipient list is diagnosable on its own. */
export function alertRecipientsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return recipients(env).length > 0;
}

type Cached = { token: string; fetchedAt: number };
let cache: Cached | null = null;
let inflight: Promise<Cached> | null = null;

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

async function fetchToken(fetchImpl: typeof fetch): Promise<Cached> {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("token response missing access_token");
  return { token: data.access_token, fetchedAt: Date.now() };
}

async function getToken(fetchImpl: typeof fetch, force = false): Promise<Cached> {
  const fresh = cache && Date.now() - cache.fetchedAt < TOKEN_TTL_SEC * 1000;
  if (!force && fresh) return cache!;
  // Collapse concurrent refreshes so a burst of alerts doesn't stampede the token endpoint.
  if (!inflight) {
    inflight = fetchToken(fetchImpl).finally(() => {
      inflight = null;
    });
  }
  cache = await inflight;
  return cache;
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

export async function sendAlertEmail(
  msg: AlertMessage,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<SendResult> {
  if (!graphMailEnabled()) return { ok: false, detail: "not configured" };
  const env = deps.env ?? process.env;
  const to = recipients(env);
  if (to.length === 0) return { ok: false, detail: "no recipients configured (ALERT_EMAIL_TO)" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  const body = JSON.stringify({
    message: {
      subject: formatEmailSubject(msg),
      body: { contentType: "HTML", content: formatEmailHtml(msg) },
      toRecipients: to.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: false,
  });

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_UPN)}/sendMail`;

  for (const attempt of [1, 2] as const) {
    let token: string;
    try {
      token = (await getToken(fetchImpl, attempt === 2)).token;
    } catch (e) {
      return { ok: false, detail: `auth error: ${(e as Error).message}` };
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
        },
        fetchImpl,
      );
    } catch (e) {
      return { ok: false, detail: `transport error: ${(e as Error).message}` };
    }
    if (res.status === 401 && attempt === 1) continue; // refresh + retry once
    if (res.status === 202) return { ok: true, detail: "202 Accepted (no delivery confirmation)" };
    // 403 is almost always a missing/mis-scoped Mail.Send grant, not transient — surface
    // it verbatim rather than retrying.
    const text = await res.text().catch(() => "");
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  return { ok: false, detail: "unreachable" };
}
