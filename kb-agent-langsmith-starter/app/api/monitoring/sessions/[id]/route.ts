// GET /api/monitoring/sessions/:id — all turns of one conversation
import { dashboardEnabled } from "@/lib/monitoring/env";
import { getSession } from "@/lib/monitoring/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const s = await getSession((await params).id);
  return s ? Response.json(s) : Response.json({ detail: "Not found" }, { status: 404 });
}
