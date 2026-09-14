// GET /api/monitoring/traces/:id[?prompt=1] — trace + step tree + errors + feedback (+ full prompt on demand)
import { dashboardEnabled } from "@/lib/monitoring/env";
import { getTrace } from "@/lib/monitoring/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await params;
  const t = await getTrace(id, { prompt: new URL(req.url).searchParams.get("prompt") === "1" });
  return t ? Response.json(t) : Response.json({ detail: "Not found" }, { status: 404 });
}
