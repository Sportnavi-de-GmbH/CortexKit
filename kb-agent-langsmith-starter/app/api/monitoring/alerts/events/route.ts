// GET /api/monitoring/alerts/events?kind&agent&cursor&limit
// DELETE /api/monitoring/alerts/events { ids: uuid[] } — bulk delete (spec §4).
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { listAlertEvents, parseEventFilters } from "@/lib/monitoring/alerts/query";
import { deleteAlertEvents, parseIds } from "@/lib/monitoring/delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  return Response.json(await listAlertEvents(parseEventFilters(new URL(req.url).searchParams)));
}

export async function DELETE(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const ids = parseIds(await req.json().catch(() => null));
  if (!ids) return Response.json({ detail: "invalid ids" }, { status: 400 });
  try {
    const result = await deleteAlertEvents(ids);
    if (!result) return Response.json({ detail: "Unavailable" }, { status: 503 });
    return Response.json(result);
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : "unknown error" }, { status: 500 });
  }
}
