// DELETE /api/monitoring/alerts/events/:id — single alert-event delete (spec §4).
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { deleteAlertEvents, parseIds } from "@/lib/monitoring/delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await params;
  const ids = parseIds({ ids: [id] });
  if (!ids) return Response.json({ detail: "invalid ids" }, { status: 400 });
  try {
    const result = await deleteAlertEvents(ids);
    if (!result) return Response.json({ detail: "Unavailable" }, { status: 503 });
    return Response.json(result);
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : "unknown error" }, { status: 500 });
  }
}
