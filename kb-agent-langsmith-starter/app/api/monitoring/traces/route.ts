// GET /api/monitoring/traces?agent&status&thumb&q&from&to&cursor&limit
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { listTraces, parseTraceFilters } from "@/lib/monitoring/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  return Response.json(await listTraces(parseTraceFilters(new URL(req.url).searchParams)));
}
