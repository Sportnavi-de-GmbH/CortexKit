// app/api/monitoring/alerts/evaluate/route.ts
// Called by pg_cron (via pg_net) in the monitoring Supabase project. Bearer secret, not cookie:
// this is machine-to-machine. Secret unset ⇒ 404 (feature off), wrong ⇒ 401.
import { timingSafeEqual } from "node:crypto";
import { runEvaluation } from "@/lib/monitoring/alerts/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request, secret: string): boolean {
  try {
    const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    // timingSafeEqual throws RangeError on unequal buffer LENGTHS, and a multibyte character
    // is longer in bytes than in JS string units — so compare byte lengths, not string lengths.
    if (!given || Buffer.byteLength(given) !== Buffer.byteLength(secret)) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  } catch {
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.ALERT_EVALUATE_SECRET?.trim();
  if (!secret) return new Response(null, { status: 404 });
  if (!authorized(req, secret)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  let body: { slot?: string; dryRun?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty body is fine */ }
  const slot = body.slot === "scheduled" || body.slot === "test" || body.slot === "manual" ? body.slot : "scheduled";
  try {
    const r = await runEvaluation({ slot, dryRun: Boolean(body.dryRun) });
    return r ? Response.json(r) : Response.json({ ok: false, skipped: "not configured" });
  } catch (e) {
    console.error("[alerts:evaluate] failed", { error: e instanceof Error ? e.message : "unknown" });
    return Response.json({ ok: false, detail: "evaluation failed" }, { status: 500 });
  }
}
