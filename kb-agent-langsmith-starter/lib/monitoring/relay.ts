// Shared handler behind app/api/monitoring/alerts/{faq,partner,orchestrator}/route.ts.
//
// Receives a Langfuse Monitor's webhook (Automations → Webhook action), verifies its
// HMAC signature, and fans the alert out to Teams + email. Each Langfuse project has its
// own webhook secret (see docs/MONITORING-ALERTING.md), so the caller identifies which
// project this route serves.
//
// INVARIANT (matches lib/langfuse.ts's "missing config ⇒ silent no-op" rule, enforced
// everywhere else Langfuse touches this repo): an unconfigured secret is a no-op, not an
// error. Past that point, ALWAYS return 2xx to Langfuse — Langfuse auto-disables an
// Automation after 5 consecutive delivery failures, and a downstream Teams/Graph outage
// is not something Langfuse retrying can fix. The one deliberate exception is an invalid
// signature (401): that's either an attacker or a misconfigured secret, and it is
// correct for persistent 401s to eventually trip the auto-disable in that case.

import { verifyLangfuseSignature } from "./hmac";
import { alreadyDelivered, markDelivered } from "./idempotency";
import { LangfuseWebhookSchema, toAlertMessage } from "./format-alert";
import { sendTeamsAlert, teamsEnabled } from "./teams";
import { sendAlertEmail, graphMailEnabled, alertRecipientsConfigured } from "./graph-mail";

export type ProjectKey = "faq" | "partner" | "orchestrator";

const PROJECT_LABELS: Record<ProjectKey, string> = {
  faq: "Navio — FAQ",
  partner: "Navio — Partner",
  orchestrator: "Navio — Multi-Agent",
};

const SECRET_ENV: Record<ProjectKey, string> = {
  faq: "LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ",
  partner: "LANGFUSE_ALERT_WEBHOOK_SECRET_PARTNER",
  orchestrator: "LANGFUSE_ALERT_WEBHOOK_SECRET_ORCHESTRATOR",
};

const MAX_REQUEST_BYTES = Number(process.env.MONITORING_MAX_REQUEST_BYTES ?? 64_000);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface RelayDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export async function handleAlertWebhook(
  req: Request,
  projectKey: ProjectKey,
  deps: RelayDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;

  if (MAX_REQUEST_BYTES > 0) {
    const len = req.headers.get("content-length");
    if (len && Number.isFinite(Number(len)) && Number(len) > MAX_REQUEST_BYTES) {
      return json({ ok: false, detail: "payload too large" }, 413);
    }
  }

  const secret = (env[SECRET_ENV[projectKey]] ?? "").trim();
  if (!secret) {
    // Silent no-op: matches this repo's Langfuse-wide "unset ⇒ nothing happens" rule.
    return json({ ok: true, skipped: "not configured" }, 200);
  }

  const rawBody = await req.text();
  const verified = verifyLangfuseSignature(rawBody, req.headers.get("x-langfuse-signature"), secret);
  if (!verified.ok) {
    console.error(`[monitoring:${projectKey}] signature rejected: ${verified.reason}`);
    return json({ ok: false, detail: "invalid signature" }, 401);
  }

  let parsed: ReturnType<typeof LangfuseWebhookSchema.safeParse>;
  try {
    parsed = LangfuseWebhookSchema.safeParse(JSON.parse(rawBody));
  } catch {
    console.error(`[monitoring:${projectKey}] payload was not valid JSON`);
    return json({ ok: true, skipped: "unrecognized payload" }, 200);
  }
  if (!parsed.success) {
    // Schema drift is OUR bug to fix, not something a Langfuse retry resolves — must
    // never risk auto-disabling a correctly configured Automation over it.
    console.error(`[monitoring:${projectKey}] payload shape mismatch:`, parsed.error.issues);
    return json({ ok: true, skipped: "unrecognized payload" }, 200);
  }

  const event = parsed.data;
  if (alreadyDelivered(event.id)) {
    return json({ ok: true, deduped: true }, 200);
  }

  const msg = toAlertMessage(event, PROJECT_LABELS[projectKey]);

  const [teamsResult, emailResult] = await Promise.allSettled([
    teamsEnabled(env) ? sendTeamsAlert(msg, deps) : Promise.resolve({ ok: false, detail: "not configured" }),
    graphMailEnabled() && alertRecipientsConfigured(env)
      ? sendAlertEmail(msg, deps)
      : Promise.resolve({ ok: false, detail: "not configured" }),
  ]);

  markDelivered(event.id);

  const teamsStatus = deliveryStatus(teamsResult, "monitoring:teams");
  const emailStatus = deliveryStatus(emailResult, "monitoring:email");

  return json({ ok: true, delivered: { teams: teamsStatus, email: emailStatus } }, 200);
}

function deliveryStatus(
  result: PromiseSettledResult<{ ok: boolean; detail: string }>,
  logPrefix: string,
): "sent" | "skipped" | "failed" {
  if (result.status === "rejected") {
    console.error(`[${logPrefix}] rejected: ${(result.reason as Error)?.message ?? result.reason}`);
    return "failed";
  }
  if (result.value.ok) return "sent";
  if (result.value.detail === "not configured") return "skipped";
  console.error(`[${logPrefix}] delivery failed: ${result.value.detail}`);
  return "failed";
}
