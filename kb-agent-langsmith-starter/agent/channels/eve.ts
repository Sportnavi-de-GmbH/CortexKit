// Route-auth policy for Navio's public HTTP API (the eve channel).
//
// Navio ships as a PUBLIC, ANONYMOUS chat widget embedded on sportnavi.de: there
// is no login. eve fails closed by default (production browser traffic is rejected
// until a channel accepts it), so this file deliberately opts the session routes
// into anonymous access — but not blindly. It is the "Layer 4" gate from the MVP
// plan (docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md), sitting behind the
// Vercel edge (Firewall origin/rate-limit rules + BotID) and in front of the model.
//
// The walk (tried in order; first to return a context wins, a throw rejects):
//   1. botCheck()     — on session-create only, reject verified bots (BotID). Skips otherwise.
//   2. widgetOrigin() — reject browsers from foreign origins (403); otherwise accept
//                       as an anonymous principal, stamping origin + a visitor id.
//   3. localDev()     — synthetic principal for loopback requests (local dev only).
//
// SECURITY NOTES (see the plan for the full rationale):
// - The chat UI is served from THIS deployment and runs inside an iframe, so the
//   widget's calls to /eve/v1/* are SAME-ORIGIN. The origin allowlist therefore
//   blocks *other* websites' browser code from calling the API; who may *embed*
//   the widget is controlled separately by `frame-ancestors` (see vercel.json).
// - `Origin` is browser-set and cannot be forged by page JavaScript, so the check
//   is reliable against in-browser abuse. It is NOT reliable against non-browser
//   callers (curl/scripts can send any Origin) — that is what BotID, edge rate
//   limiting, and the AI-Gateway hard spend cap are for. This gate is defense in
//   depth, never the only control.
// - eve does not enforce session ownership. For a single anonymous audience that is
//   low risk at MVP; eve's per-session continuationToken already scopes follow-ups
//   to the session that cleared this gate.

import { type AuthFn, ForbiddenError, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Extra origins allowed to call the API in ADDITION to this deployment's own
 * origin (which is always allowed, since the widget iframe is same-origin).
 * Set `WIDGET_ALLOWED_ORIGINS` (comma-separated) only if you serve the widget
 * cross-origin, e.g. "https://www.sportnavi.de,https://sportnavi.de".
 */
function extraAllowedOrigins(): string[] {
  return (process.env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Read a cookie value from the raw request `Cookie` header. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** The origin the caller claims, from `Origin` or (fallback) `Referer`. */
function callerOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/** True for `POST /eve/v1/session` (session creation), not follow-ups or stream. */
function isSessionCreate(request: Request): boolean {
  if (request.method !== "POST") return false;
  try {
    return /\/eve\/v1\/session$/.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

/**
 * BotID gate (Vercel BotID, invisible bot detection). Off unless
 * `BOTID_ENABLED=true` so local dev, tests, and typecheck are unaffected and the
 * module stays importable without the `botid` package. In production on Vercel
 * Pro (with `botid` installed and `initBotId()` running in the widget page), it
 * rejects verified bots on the expensive session-create route.
 *
 * Returns `null` (skip) for humans and for every non-session-create request so
 * the walk continues to `widgetOrigin()`.
 */
function botCheck(): AuthFn<Request> {
  return async (request) => {
    if (process.env.BOTID_ENABLED !== "true") return null;
    if (!isSessionCreate(request)) return null;

    // Indirect specifier keeps this importable/typecheckable without the optional
    // `botid` dependency; install it (`npm i botid`) to activate in production.
    const specifier = "botid/server";
    const mod = (await import(specifier)) as {
      checkBotId: () => Promise<{ isBot: boolean }>;
    };
    const verdict = await mod.checkBotId();
    if (verdict.isBot) {
      throw new ForbiddenError({ message: "Automated traffic is not allowed." });
    }
    return null; // human: continue the walk
  };
}

/**
 * Origin allowlist + anonymous acceptance. Rejects (403) any browser request
 * whose `Origin` is present and not allowed; otherwise accepts anonymously and
 * records the caller origin and a first-party visitor id (cookie `snv_vid` or
 * header `x-snv-visitor`) so the runtime can attribute per-visitor spend/analytics.
 *
 * A request with no Origin/Referer (same-origin GET streams legitimately omit
 * `Origin`, and so do non-browser callers) is accepted here and left to the edge
 * (BotID / rate limit) and the spend cap — this keeps the streaming route working
 * while still blocking cross-site browsers, which always send `Origin`.
 */
/** Host (with port) the browser actually addressed, honoring proxy headers. */
function requestHost(request: Request): string | null {
  return request.headers.get("x-forwarded-host") ?? request.headers.get("host");
}

/**
 * Loopback origins (local dev) are safe to allow: a real production browser
 * never sends a `localhost` Origin, and a non-browser caller that forges one is
 * already handled by BotID / rate limiting / the spend cap (an Origin header is
 * not a security boundary against scripts). This keeps `npm run dev` working
 * behind the Next dev proxy without loosening production.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function widgetOrigin(): AuthFn<Request> {
  return (request) => {
    const allowed = new Set<string>(extraAllowedOrigins());
    try {
      allowed.add(new URL(request.url).origin);
    } catch {
      /* request.url may be an internal proxy URL — the Host check below covers it */
    }

    const origin = callerOrigin(request);
    if (origin) {
      // The widget iframe is SAME-ORIGIN with the API, so its `Origin` host equals
      // the Host header the browser addressed. Accept that (robust behind proxies
      // that rewrite request.url), plus explicit allow-listed and loopback origins.
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed Origin — fall through to reject */
      }
      const sameOrigin = !!originHost && originHost === requestHost(request);
      if (!allowed.has(origin) && !sameOrigin && !isLoopbackOrigin(origin)) {
        throw new ForbiddenError({ message: "Origin not allowed." });
      }
    }

    const visitorId =
      readCookie(request, "snv_vid") ??
      request.headers.get("x-snv-visitor") ??
      undefined;

    const attributes: Record<string, string> = {};
    if (origin) attributes.origin = origin;
    if (visitorId) attributes.visitorId = visitorId;

    // Structurally a SessionAuthContext (checked via the AuthFn return type).
    return {
      attributes,
      authenticator: "widget-origin",
      principalId: visitorId ?? "anonymous",
      principalType: "anonymous",
    };
  };
}

export default eveChannel({
  auth: [botCheck(), widgetOrigin(), localDev()],
  // Same-origin (iframe) calls need no CORS. Configure narrow CORS only if you
  // serve the widget cross-origin via WIDGET_ALLOWED_ORIGINS.
  ...(extraAllowedOrigins().length > 0
    ? {
        cors: {
          origin: extraAllowedOrigins(),
          methods: ["GET", "POST"] as const,
          allowedHeaders: ["authorization", "content-type", "x-snv-visitor"],
        },
      }
    : {}),
});
