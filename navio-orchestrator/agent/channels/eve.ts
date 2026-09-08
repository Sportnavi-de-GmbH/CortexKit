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
import {
  TOO_LONG_API_DETAIL,
  extractMessageText,
  isMessageTooLong,
} from "../../lib/message-limits";

/**
 * Max bytes accepted on any request that carries a body (chat session-create +
 * follow-up messages). Guards against oversized-message abuse: a huge pasted
 * message inflates input tokens/cost on every turn. The finer per-message
 * character cap lives in messageLengthLimit() below. Checked
 * cheaply via `Content-Length` — we reject BEFORE the body is read or the model
 * is called. Default 16 KB comfortably fits a normal message + JSON envelope
 * while blocking multi-KB pastes. Env-tunable; `0` disables the check.
 */
const MAX_REQUEST_BYTES = Number(process.env.NAVIO_MAX_REQUEST_BYTES ?? 16_000);

/**
 * Reject requests whose declared body size exceeds MAX_REQUEST_BYTES. Returns
 * `null` (continue the walk) for GET/stream requests and bodies within the cap;
 * a missing/unparseable Content-Length is allowed here and left to the edge
 * (Firewall body-size rules) — this is defense in depth, not the only control.
 */
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

/**
 * Reject a chat message longer than the SHARED cap (lib/message-limits.ts), the
 * same number the widget's counter shows. Runs after the byte cap, so the body
 * read here is already bounded to a few KB.
 *
 * Why a body check at all, when MAX_REQUEST_BYTES exists: the byte cap is a
 * blunt transport guard on the whole envelope, and it cannot be shown to the
 * visitor as "you have N characters left". This one enforces exactly what the
 * UI promises, so a caller that skips the UI gets the same answer the UI gives.
 *
 * The body is read from a CLONE — the original stream stays intact for eve.
 * Anything that is not a JSON object with a string `message` is passed through
 * untouched: this is a length guard, not a protocol validator.
 */
function messageLengthLimit(): AuthFn<Request> {
  return async (request) => {
    if (request.method !== "POST") return null;
    const type = request.headers.get("content-type") ?? "";
    if (!type.includes("json")) return null;

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return null; // unreadable/!JSON — not this gate's business
    }

    const message = extractMessageText(body);
    if (message !== null && isMessageTooLong(message)) {
      throw new ForbiddenError({ message: TOO_LONG_API_DETAIL });
    }
    return null;
  };
}

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
 * Loopback origins (local dev) are accepted OUTSIDE production only. A real
 * production browser never sends a `localhost` Origin, so allowing it there buys
 * nothing and only widens the surface for a forged-Origin script (which BotID /
 * rate limiting / the spend cap already backstop). Gating on `VERCEL_ENV`
 * (`preview`/`development`/unset — i.e. not `production`) keeps `npm run dev` and
 * preview deploys working behind the Next dev proxy while closing the hole in
 * production. This function is only reached when an Origin header is present.
 */
function isLoopbackOrigin(origin: string): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
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
  // Size gate runs FIRST so oversized bodies are rejected cheaply, then the
  // character cap (the same number the widget's counter shows), before BotID
  // or origin checks and long before the model call.
  auth: [requestSizeLimit(), messageLengthLimit(), botCheck(), widgetOrigin(), localDev()],
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
