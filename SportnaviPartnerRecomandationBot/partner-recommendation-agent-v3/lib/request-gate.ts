/**
 * lib/request-gate.ts — the front door of /api/workflow in production.
 *
 * V3 is consumed by ONE caller: the Navio widget's server-side forwarder
 * (kb-agent-langsmith-starter/lib/partner-workflow.ts). Browsers never talk to
 * V3 directly, so the security model is plain server-to-server:
 *
 *   auth   — HTTP Basic `navio-proxy:<PARTNER_PROXY_SECRET>`, the same scheme the
 *            widget already uses for the eve-based partner agent. Compared in
 *            constant time. No secret configured ⇒ production FAILS CLOSED (503);
 *            outside production only loopback callers get through (the local
 *            dev UI), never a remote one.
 *   size   — a content-length cap (the body is small JSON: one message + ≤ 20 tasks).
 *   rate   — a per-caller token window. This runs per serverless instance, so it
 *            is a soft brake against a runaway client; the hard control is the
 *            Vercel Firewall rate-limit rule on the deployment.
 *
 * Everything here is pure (env and clock injectable) so it is unit-tested.
 */
import { timingSafeEqual } from "node:crypto";

export const PROXY_USER = "navio-proxy";

type Env = Record<string, string | undefined>;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function isProduction(env: Env): boolean {
  return env.VERCEL_ENV === "production" || (env.VERCEL_ENV === undefined && env.NODE_ENV === "production");
}

function isLoopback(req: Request): boolean {
  let host = req.headers.get("host") ?? "";
  try {
    host = new URL(req.url).hostname || host;
  } catch {
    /* keep header */
  }
  host = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host.endsWith(".localhost");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `null` to continue, otherwise the rejection to return. */
export function checkAuth(req: Request, env: Env = process.env): Response | null {
  const secret = env.PARTNER_PROXY_SECRET?.trim();
  if (!secret) {
    if (isProduction(env)) {
      console.error("[v3] PARTNER_PROXY_SECRET is not set in production — refusing every request (fail closed).");
      return json({ error: "Service not configured." }, 503);
    }
    return isLoopback(req) ? null : json({ error: "Unauthorized." }, 401);
  }
  const header = req.headers.get("authorization") ?? "";
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header);
  if (!m) return json({ error: "Unauthorized." }, 401);
  let decoded = "";
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return json({ error: "Unauthorized." }, 401);
  }
  const ok = safeEqual(decoded, `${PROXY_USER}:${secret}`);
  return ok ? null : json({ error: "Unauthorized." }, 401);
}

/** `null` to continue, 413 above `maxBytes`. Unknown length is left to the JSON parser. */
export function checkBodySize(req: Request, maxBytes: number): Response | null {
  const len = Number(req.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) return json({ error: "Request too large." }, 413);
  return null;
}

/** Fixed-window counter per caller key. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** true when the request may proceed. */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      if (this.hits.size > 10_000) this.hits.clear(); // bounded memory on a long-lived instance
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count++;
    return true;
  }

  static clientKey(req: Request): string {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim() || "unknown";
    return req.headers.get("x-real-ip")?.trim() || "unknown";
  }
}
