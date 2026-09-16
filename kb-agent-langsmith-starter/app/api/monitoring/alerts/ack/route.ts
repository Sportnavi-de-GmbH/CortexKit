// POST /api/monitoring/alerts/ack { id, by }
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { supabaseAdmin } from "@/lib/monitoring/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; by?: string };
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return Response.json({ detail: "bad id" }, { status: 400 });
  const by = (body.by ?? "").trim().slice(0, 60) || "Team";
  const db = supabaseAdmin();
  if (!db) return Response.json({ detail: "Unavailable" }, { status: 503 });
  const { error } = await db
    .from("alert_events")
    .update({ acknowledged_by: by, acknowledged_at: new Date().toISOString() })
    .eq("id", body.id);
  return error ? Response.json({ detail: error.message }, { status: 500 }) : Response.json({ ok: true });
}
