// GET /api/monitoring/traces/:id[?prompt=1] — trace + step tree + errors + feedback (+ full prompt on demand)
// DELETE /api/monitoring/traces/:id — single-trace delete (spec §4).
import { after } from "next/server";
import { dashboardEnabled } from "@/lib/monitoring/env";
import { getTrace } from "@/lib/monitoring/query";
import { deleteTraces, parseIds } from "@/lib/monitoring/delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The post-delete alert re-evaluation may continue past the response via `after()` — give it room.
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await params;
  const t = await getTrace(id, { prompt: new URL(req.url).searchParams.get("prompt") === "1" });
  return t ? Response.json(t) : Response.json({ detail: "Not found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await params;
  const ids = parseIds({ ids: [id] });
  if (!ids) return Response.json({ detail: "invalid ids" }, { status: 400 });
  try {
    const result = await deleteTraces(ids, { keepAlive: (p) => after(() => p) });
    if (!result) return Response.json({ detail: "Unavailable" }, { status: 503 });
    return Response.json(result);
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : "unknown error" }, { status: 500 });
  }
}
