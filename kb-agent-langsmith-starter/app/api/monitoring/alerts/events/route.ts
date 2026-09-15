// GET /api/monitoring/alerts/events?kind&agent&cursor&limit
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { listAlertEvents, parseEventFilters } from "@/lib/monitoring/alerts/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  return Response.json(await listAlertEvents(parseEventFilters(new URL(req.url).searchParams)));
}
