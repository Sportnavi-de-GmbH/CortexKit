// Route-auth policy for the Partner Agent's HTTP API (the eve channel).
//
// This service is INTERNAL. It is never called by a browser: the only legitimate
// caller is the Navio widget's server-side proxy (Service 1,
// kb-agent-langsmith-starter/lib/partner-proxy.ts), which forwards `/eve/v1/*`
// requests from `PARTNER_AGENT_HOST`. Without this file, eve falls back to its
// framework-default channel (`[vercelOidc(), localDev()]`), which on a real
// production domain 401s the proxy (it presents no Vercel OIDC token) — so the
// widget's "Partner finden" card would break. This file makes the proxy the one
// authenticated caller via a shared secret, and keeps everyone else out.
//
// The walk (tried in order; first to return a context wins, a throw rejects,
// `null` skips to the next entry; exhausting the walk returns 401):
//   1. requestSizeLimit() — reject oversized bodies cheaply, before anything else.
//   2. httpBasic(...)      — accept the proxy's shared-secret credential.
//                            ONLY present when PARTNER_PROXY_SECRET is configured,
//                            so a misconfigured deployment fails CLOSED (401) rather
//                            than open. A wrong/absent credential returns null (skip).
//   3. vercelOidc()        — Vercel's own runtime callers (current-project tokens).
//   4. localDev()          — synthetic principal for loopback requests (local dev).
//
// SECURITY NOTES:
// - The shared secret travels in the `Authorization: Basic <base64>` header the
//   proxy injects. HTTP Basic compares the password in constant time (eve's
//   verifyHttpBasic), so it does not leak via timing. Keep PARTNER_PROXY_SECRET
//   identical on both projects; rotate by updating both and redeploying.
// - `/eve/v1/health` is registered OUTSIDE this channel's auth walk (by the Nitro
//   host), so it stays public for uptime checks — it exposes no agent data.
// - This gate is defense in depth behind the Vercel edge (Firewall + a non-public
//   domain / Deployment Protection). It is the authoritative service-to-service
//   auth, which the edge alone cannot provide (serverless egress IPs are not
//   static, and server-side request headers are attacker-controllable).

import { type AuthFn, ForbiddenError, httpBasic, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * The shared secret Service 1's proxy presents as the HTTP Basic password
 * (username is the fixed literal "navio-proxy"). MUST match Service 1's
 * `PARTNER_PROXY_SECRET`. Trimmed so trailing whitespace pasted into a dashboard
 * env field doesn't silently break the match.
 */
const PROXY_SECRET = process.env.PARTNER_PROXY_SECRET?.trim() ?? "";

/**
 * Max bytes accepted on any request that carries a body (a partner search is a
 * small JSON envelope — city + intent + tags). Rejects oversized-body abuse via
 * `Content-Length` before the body is read or the model is called. Env-tunable
 * with `PARTNER_MAX_REQUEST_BYTES`; `0` disables. A missing/unparseable
 * Content-Length is deferred to the edge (defense in depth, not the only control).
 */
const MAX_REQUEST_BYTES = Number(process.env.PARTNER_MAX_REQUEST_BYTES ?? 16_000);

function requestSizeLimit(): AuthFn<Request> {
  return (request) => {
    if (MAX_REQUEST_BYTES <= 0) return null;
    const header = request.headers.get("content-length");
    if (!header) return null; // no declared length (GET stream / chunked) → defer
    const bytes = Number(header);
    if (Number.isFinite(bytes) && bytes > MAX_REQUEST_BYTES) {
      throw new ForbiddenError({ message: "Message too large." });
    }
    return null;
  };
}

// Include the shared-secret verifier ONLY when the secret is set. Omitting it
// when unset means a misconfigured production deployment has no credential that
// can pass, so the walk falls through to Vercel OIDC / localDev and ends in a
// 401 — fail closed. (Including httpBasic with an empty password would risk
// accepting an empty-password credential — never do that.)
const proxyAuth: AuthFn<Request>[] = PROXY_SECRET
  ? [httpBasic({ username: "navio-proxy", password: PROXY_SECRET })]
  : [];

export default eveChannel({
  auth: [requestSizeLimit(), ...proxyAuth, vercelOidc(), localDev()],
});
