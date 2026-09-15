// PATCH /api/monitoring/alerts/rules/:id
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { supabaseAdmin } from "@/lib/monitoring/store";
import { RulePatchSchema } from "@/lib/monitoring/alerts/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ detail: "bad id" }, { status: 400 });
  const parsed = RulePatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ detail: "invalid", issues: parsed.error.issues }, { status: 400 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ detail: "Unavailable" }, { status: 503 });
  const { data, error } = await db
    .from("alert_rules")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return Response.json({ detail: error.message }, { status: 500 });
  return data ? Response.json(data) : new Response(null, { status: 404 });
}
