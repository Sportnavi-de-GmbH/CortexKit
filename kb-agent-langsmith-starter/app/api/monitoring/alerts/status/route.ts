// GET /api/monitoring/alerts/status — currently breached rule instances.
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { breachedStates } from "@/lib/monitoring/alerts/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const breached = await breachedStates();
  return Response.json({ breached, count: breached.length });
}
