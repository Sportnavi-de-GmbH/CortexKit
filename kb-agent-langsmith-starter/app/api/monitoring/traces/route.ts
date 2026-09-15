// GET /api/monitoring/traces?agent&status&thumb&q&from&to&cursor&limit
// DELETE /api/monitoring/traces { ids: uuid[] } — bulk delete (spec §4).
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { after } from "next/server";
import { dashboardEnabled } from "@/lib/monitoring/env";
import { listTraces, parseTraceFilters } from "@/lib/monitoring/query";
import { deleteTraces, parseIds } from "@/lib/monitoring/delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The post-delete alert re-evaluation may continue past the response via `after()` — give it room.
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  return Response.json(await listTraces(parseTraceFilters(new URL(req.url).searchParams)));
}

export async function DELETE(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const ids = parseIds(await req.json().catch(() => null));
  if (!ids) return Response.json({ detail: "invalid ids" }, { status: 400 });
  try {
    const result = await deleteTraces(ids, { keepAlive: (p) => after(() => p) });
    if (!result) return Response.json({ detail: "Unavailable" }, { status: 503 });
    return Response.json(result);
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : "unknown error" }, { status: 500 });
  }
}
