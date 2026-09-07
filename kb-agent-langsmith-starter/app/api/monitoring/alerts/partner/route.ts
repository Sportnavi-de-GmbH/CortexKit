// Webhook target for the "Navio — Partner" Langfuse project's Monitors → Automation.
// Lives here (in the widget app) rather than the partner service so both projects'
// alerts share one set of Teams/Graph credentials — see docs/MONITORING-ALERTING.md.
// Thin wrapper — see lib/monitoring/relay.ts for the actual logic.

import { handleAlertWebhook } from "@/lib/monitoring/relay";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  return handleAlertWebhook(req, "partner");
}
