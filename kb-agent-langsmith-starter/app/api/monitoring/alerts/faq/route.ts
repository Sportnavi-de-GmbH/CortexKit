// Webhook target for the "Navio — FAQ" Langfuse project's Monitors → Automation.
// Thin wrapper — see lib/monitoring/relay.ts for the actual logic.

import { handleAlertWebhook } from "@/lib/monitoring/relay";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  return handleAlertWebhook(req, "faq");
}
