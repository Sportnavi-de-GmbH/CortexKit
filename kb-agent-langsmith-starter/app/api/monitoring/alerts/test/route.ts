// POST /api/monitoring/alerts/test — sends a test alert to every configured channel.
// Guarded by middleware.ts (cookie) — the 404 below is belt to its braces.
import { dashboardEnabled } from "@/lib/monitoring/env";
import { deliver, testMessage } from "@/lib/monitoring/alerts/deliver";
import { dashboardUrl } from "@/lib/monitoring/alerts/evaluate";
import { getAlertSettings } from "@/lib/monitoring/alerts/query";
import { supabaseAdmin } from "@/lib/monitoring/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const settings = await getAlertSettings();
  const msg = testMessage(dashboardUrl());
  const delivery = await deliver(msg, { teams: true, email: true }, { recipients: settings.email_recipients });
  const db = supabaseAdmin();
  if (db) {
    await db
      .from("alert_events")
      .insert({ kind: "test", narrative: msg.detail, narrative_source: "template", delivery, run_slot: `test:${new Date().toISOString()}` });
  }
  return Response.json({ delivery });
}
