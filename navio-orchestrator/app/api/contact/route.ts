// POST /api/contact — server-side contact endpoint (SERVER ONLY).
//
// Served by the Next.js app (not eve — eve only owns /eve/v1/*). The browser posts a
// flat JSON payload here; this handler validates it, maps it to the Salesforce flow
// inputs, and creates a Case server-side. Salesforce credentials never reach the client.
//
// Defense in depth (docs/reference/kontakt-formular.md §10): an Origin allowlist + a
// light per-IP rate limit live here because eve's fail-closed edge auth does NOT cover
// /api/*. The per-instance limiter is a soft guard — the real control in production is a
// Vercel Firewall rule on /api/contact (like the chat routes).

import { ContactSchema, toSalesforceInputs } from "@/lib/contact/schema";
import { salesforceEnabled, submitCase } from "@/lib/contact/salesforce";

export const runtime = "nodejs";
// Bound execution time so a stalled Salesforce call can't hold the function open
// (and billing) indefinitely (production-readiness review §P2.6). The Salesforce
// client has its own 15s fetch timeout; this is the outer backstop.
export const maxDuration = 30;

const RATE_LIMIT_PER_MIN = Number(process.env.CONTACT_RATE_LIMIT_PER_MIN ?? 15);

/**
 * Redact PII before logging. The contact payload carries name/email/free-text
 * (GDPR-relevant for a German fitness network), so we log field NAMES and sizes,
 * never values. (Review §G4.)
 */
function safeShape(inputs: Record<string, string>): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const [k, v] of Object.entries(inputs)) shape[k] = typeof v === "string" ? v.length : 0;
  return shape;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extra browser origins allowed in addition to this deployment's own origin. */
function extraAllowedOrigins(): string[] {
  return (process.env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Same-origin (the widget iframe), loopback dev, or an allow-listed origin. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser / same-origin POSTs may omit Origin
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const reqHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host === reqHost) return true; // same-origin (the widget)
  const hostname = host.split(":")[0];
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) {
    return true; // local dev
  }
  return extraAllowedOrigins().includes(origin);
}

// Per-instance, per-IP fixed-window limiter. Soft guard only (not distributed).
const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const slot = hits.get(ip);
  if (!slot || now > slot.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  slot.count += 1;
  return slot.count > RATE_LIMIT_PER_MIN;
}

// Idempotency: a double-click/retry with the same `Idempotency-Key` must not
// create a second Salesforce Case (review §P1.3). Per-instance, short-lived
// SOFT guard — like the rate limiter, a distributed store (Vercel KV) is needed
// to be authoritative across the serverless fleet. Still catches the common
// same-instance double-submit.
const seen = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
function alreadyHandled(key: string | null): boolean {
  if (!key) return false;
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > IDEMPOTENCY_TTL_MS) seen.delete(k); // prune
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

export async function POST(req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ detail: "Origin not allowed." }, 403);

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return json({ detail: "Zu viele Anfragen. Bitte versuche es später erneut." }, 429);
  }

  // Short-circuit duplicate submissions (double-click / client retry).
  if (alreadyHandled(req.headers.get("idempotency-key"))) {
    return json({ status: "ok", deduped: true }, 200);
  }

  const raw = await req.json().catch(() => null);
  const parsed = ContactSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ detail: parsed.error.issues }, 422);
  }

  const inputs = toSalesforceInputs(parsed.data);

  // Simulate mode — no credentials configured. The form stays fully demoable.
  if (!salesforceEnabled()) {
    console.warn("CONTACT (simulated):", safeShape(inputs)); // field sizes only, no PII
    return json({ status: "ok", simulated: true }, 200);
  }

  const { ok, detail } = await submitCase(inputs);
  if (ok) return json({ status: "ok" }, 200);

  // Salesforce failed. No SMTP fallback wired yet — log the failure detail + payload
  // SHAPE (no PII values) so an alert can fire without leaking data. NOTE: without an
  // email fallback a Salesforce outage still drops the lead — wire nodemailer + SMTP_*.
  console.error("CONTACT failed (no email fallback configured):", detail, safeShape(inputs));
  return json({ detail: "Senden fehlgeschlagen. Bitte später erneut versuchen." }, 502);
}
