// GET/PATCH /api/monitoring/alerts/settings
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { supabaseAdmin } from "@/lib/monitoring/store";
import { getAlertSettings, SettingsPatchSchema } from "@/lib/monitoring/alerts/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  return Response.json(await getAlertSettings());
}

export async function PATCH(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const parsed = SettingsPatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ detail: "invalid", issues: parsed.error.issues }, { status: 400 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ detail: "Unavailable" }, { status: 503 });
  const { data, error } = await db
    .from("alert_settings")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("*")
    .maybeSingle();
  if (error) return Response.json({ detail: error.message }, { status: 500 });
  return data ? Response.json(data) : new Response(null, { status: 404 });
}
