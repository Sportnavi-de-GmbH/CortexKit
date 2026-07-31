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

const RATE_LIMIT_PER_MIN = Number(process.env.CONTACT_RATE_LIMIT_PER_MIN ?? 15);

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

export async function POST(req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ detail: "Origin not allowed." }, 403);

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return json({ detail: "Zu viele Anfragen. Bitte versuche es später erneut." }, 429);
  }

  const raw = await req.json().catch(() => null);
  const parsed = ContactSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ detail: parsed.error.issues }, 422);
  }

  const inputs = toSalesforceInputs(parsed.data);

  // Simulate mode — no credentials configured. The form stays fully demoable.
  if (!salesforceEnabled()) {
    console.warn("CONTACT (simulated):", inputs);
    return json({ status: "ok", simulated: true }, 200);
  }

  const { ok, detail } = await submitCase(inputs);
  if (ok) return json({ status: "ok" }, 200);

  // Salesforce failed. No SMTP fallback wired yet — log the full payload so nothing is
  // lost (recoverable from logs). Add nodemailer + SMTP_* later for email fallback.
  console.error("CONTACT failed (no email fallback configured):", detail, inputs);
  return json({ detail: "Senden fehlgeschlagen. Bitte später erneut versuchen." }, 502);
}
