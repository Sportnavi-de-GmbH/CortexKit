// POST /api/monitoring/alerts/run { dryRun? } — manual evaluation run from the dashboard.
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { runEvaluation } from "@/lib/monitoring/alerts/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
  try {
    const r = await runEvaluation({ slot: "manual", dryRun: Boolean(body.dryRun) });
    return r ? Response.json(r) : Response.json({ detail: "Unavailable" }, { status: 503 });
  } catch (e) {
    console.error("[alerts:run] failed", { error: e instanceof Error ? e.message : "unknown" });
    return Response.json({ ok: false, detail: "evaluation failed" }, { status: 500 });
  }
}
