// Salesforce connector for the contact form — SERVER ONLY.
//
// GOLDEN RULE: the browser never talks to Salesforce. The client_id/client_secret
// are read from server env and never sent to the client. This module is imported
// only by the `/api/contact` route handler (a server-only Next.js Route Handler).
//
// Two Salesforce calls (docs/reference/kontakt-formular.md §5):
//   1. OAuth `client_credentials` → access token (cached, refreshed on expiry/401)
//   2. POST the CaseHandler flow with the mapped inputs
//
// SIMULATE MODE: if either credential is blank, `salesforceEnabled()` is false —
// callers should skip the network and return a simulated success. That's the
// default until the env vars are configured.

const CLIENT_ID = (process.env.SALESFORCE_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.SALESFORCE_CLIENT_SECRET ?? "").trim();
const TOKEN_URL = (
  process.env.SALESFORCE_TOKEN_URL ??
  "https://sportnavi.my.salesforce.com/services/oauth2/token"
).trim();
const INSTANCE_URL = (
  process.env.SALESFORCE_INSTANCE_URL ?? "https://sportnavi.my.salesforce.com"
)
  .trim()
  .replace(/\/+$/, "");
const API_VERSION = (process.env.SALESFORCE_API_VERSION ?? "v65.0").trim();
const FLOW_API_NAME = (process.env.SALESFORCE_FLOW_API_NAME ?? "CaseHandler").trim();
const TOKEN_TTL_SEC = Number(process.env.SALESFORCE_TOKEN_TTL_SEC ?? 3600);
const TIMEOUT_MS = Number(process.env.SALESFORCE_TIMEOUT_SEC ?? 15) * 1000;

/** True only when both OAuth credentials are present; otherwise → simulate mode. */
export function salesforceEnabled(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

type Cached = { token: string; instance: string; fetchedAt: number };
let cache: Cached | null = null;
let inflight: Promise<Cached> | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchToken(): Promise<Cached> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { access_token?: string; instance_url?: string };
  if (!data.access_token) throw new Error("token response missing access_token");
  return {
    token: data.access_token,
    instance: (data.instance_url ?? INSTANCE_URL).replace(/\/+$/, ""),
    fetchedAt: Date.now(),
  };
}

async function getToken(force = false): Promise<Cached> {
  const fresh = cache && Date.now() - cache.fetchedAt < TOKEN_TTL_SEC * 1000;
  if (!force && fresh) return cache!;
  // Collapse concurrent refreshes so we don't stampede the token endpoint.
  if (!inflight) {
    inflight = fetchToken().finally(() => {
      inflight = null;
    });
  }
  cache = await inflight;
  return cache;
}

/**
 * Trigger the CaseHandler flow with the mapped inputs.
 * Returns { ok, detail }. `ok` is true only when the flow's first result has
 * isSuccess === true. Retries once after a forced token refresh on a 401.
 */
export async function submitCase(
  inputs: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  if (!salesforceEnabled()) return { ok: false, detail: "salesforce not configured" };
  const body = JSON.stringify({ inputs: [inputs] });

  for (const attempt of [1, 2] as const) {
    let creds: Cached;
    try {
      creds = await getToken(attempt === 2);
    } catch (e) {
      return { ok: false, detail: `auth error: ${(e as Error).message}` };
    }
    const url = `${creds.instance}/services/data/${API_VERSION}/actions/custom/flow/${FLOW_API_NAME}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (e) {
      return { ok: false, detail: `transport error: ${(e as Error).message}` };
    }
    if (res.status === 401 && attempt === 1) continue; // refresh + retry once
    if (res.status >= 400) {
      return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` };
    }
    let first: { isSuccess?: boolean; errors?: unknown } = {};
    try {
      const results = (await res.json()) as unknown;
      first = Array.isArray(results) && results.length ? (results[0] as typeof first) : {};
    } catch {
      return { ok: false, detail: "unparseable flow response" };
    }
    if (first.isSuccess === true) return { ok: true, detail: "ok" };
    return { ok: false, detail: `flow isSuccess=false: ${JSON.stringify(first.errors ?? first)}` };
  }
  return { ok: false, detail: "unreachable" };
}
