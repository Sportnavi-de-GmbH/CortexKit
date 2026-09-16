// Shared-password dashboard auth. Web Crypto only: this module is imported by
// middleware.ts (edge runtime) as well as the node route handlers.
export const COOKIE_NAME = "navio_monitoring";
export const COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `${expiresAtSec}.${hmac}` — the expiry is the signed message, so it cannot be extended. */
export async function signSession(secret: string, expiresAtSec: number): Promise<string> {
  return `${expiresAtSec}.${await hmacHex(secret, String(expiresAtSec))}`;
}

export async function verifySession(
  secret: string,
  token: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !token) return false;
  const [expStr, sig] = token.split(".");
  if (!expStr || !sig || !/^\d+$/.test(expStr)) return false;
  if (Number(expStr) <= nowSec) return false;
  return equalHex(await hmacHex(secret, expStr), sig);
}

/** Constant-time compare by hashing both sides with the same fixed key. */
export async function passwordMatches(expected: string, given: string): Promise<boolean> {
  if (!expected || !given) return false;
  const k = "navio-monitoring-password-compare";
  return equalHex(await hmacHex(k, expected), await hmacHex(k, given));
}

/** 5 failed logins per IP per 15 min (per instance; the Firewall is the real control in production). */
export function createLoginThrottle(opts: { max?: number; windowMs?: number; now?: () => number } = {}) {
  const max = opts.max ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const fails = new Map<string, { count: number; resetAt: number }>();
  return {
    check(ip: string): boolean {
      const e = fails.get(ip);
      if (!e || now() > e.resetAt) return true;
      return e.count < max;
    },
    fail(ip: string): void {
      const e = fails.get(ip);
      if (!e || now() > e.resetAt) fails.set(ip, { count: 1, resetAt: now() + windowMs });
      else e.count += 1;
    },
  };
}

export function cookieHeader(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}${secure ? "; Secure" : ""}`;
}

/** /monitoring/* except the login page, plus the three data-API families. */
export function isProtectedPath(pathname: string): boolean {
  if (pathname === "/monitoring/login") return false;
  if (pathname === "/monitoring" || pathname.startsWith("/monitoring/")) return true;
  if (/^\/api\/monitoring\/(traces|stats|sessions)(\/|$)/.test(pathname)) return true;
  // Alert dashboard API — but NOT the machine endpoints: evaluate (bearer) and the Langfuse relay (HMAC).
  return /^\/api\/monitoring\/alerts\/(events|rules|settings|ack|test|run|status)(\/|$)/.test(pathname);
}
