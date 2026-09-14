// GET /api/monitoring/stats?range=24h|7d|30d — the overview KPIs
import { dashboardEnabled } from "@/lib/monitoring/env";
import { getStats } from "@/lib/monitoring/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const r = new URL(req.url).searchParams.get("range");
  const range = r === "7d" || r === "30d" ? r : "24h";
  const s = await getStats(range);
  return s ? Response.json(s) : Response.json({ detail: "Unavailable" }, { status: 503 });
}
