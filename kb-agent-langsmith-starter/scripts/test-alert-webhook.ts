// Manual/live verification for the Langfuse → Teams/email alert relay
// (docs/MONITORING-ALERTING.md). Builds a synthetic, correctly-shaped
// Langfuse "monitor-alert" webhook, signs it with a real HMAC, and POSTs it
// at a running relay endpoint — local dev or a deployed preview.
//
// There is nothing to "read back" the way scripts/verify-langfuse.ts reads a trace
// back from the API — a webhook has no queryable record of its own. The honest check
// here is printing the relay's response and then visually confirming the message
// actually arrived in Teams / the inbox. Run this against a TEST Teams channel and a
// TEST mailbox (temporarily point TEAMS_ALERT_WEBHOOK_URL / ALERT_EMAIL_TO at them),
// not production ones — see docs/MONITORING-ALERTING.md's safe-testing procedure for
// verifying against a real Langfuse-triggered alert instead.
//
// Usage:
//   npx tsx scripts/test-alert-webhook.ts <project> <secret> [url] [severity]
//
//   <project>  faq | partner | orchestrator — which route/label to simulate
//   <secret>   the webhook secret from that Langfuse project's Automation
//   [url]      target base URL, default http://127.0.0.1:3010
//   [severity] ALERT | WARNING | OK | NO_DATA | PAUSED, default ALERT
import "../lib/load-env.ts";

import { createHmac, randomUUID } from "node:crypto";

const [projectArg, secretArg, urlArg, severityArg] = process.argv.slice(2);

if (!projectArg || !secretArg) {
  console.error("Usage: npx tsx scripts/test-alert-webhook.ts <project> <secret> [url] [severity]");
  console.error("  <project>: faq | partner | orchestrator");
  process.exit(1);
}
if (!["faq", "partner", "orchestrator"].includes(projectArg)) {
  console.error(`Unknown project "${projectArg}" — expected faq | partner | orchestrator`);
  process.exit(1);
}

const baseUrl = (urlArg ?? "http://127.0.0.1:3010").replace(/\/+$/, "");
const severity = severityArg ?? "ALERT";
const targetUrl = `${baseUrl}/api/monitoring/alerts/${projectArg}`;

const body = JSON.stringify({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  type: "monitor-alert",
  apiVersion: "v1",
  payload: {
    monitorId: "monitor_test",
    projectId: "proj_test",
    permalink: `${baseUrl}`,
    message: {
      title: "[TEST] synthetic alert from scripts/test-alert-webhook.ts",
      body: "This is a manually triggered test payload, not a real Langfuse alert.",
    },
    severity,
    fromTimestamp: new Date(Date.now() - 3_600_000).toISOString(),
    toTimestamp: new Date().toISOString(),
    view: "observations",
    window: "1h",
  },
});

const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac("sha256", secretArg).update(`${timestamp}.${body}`, "utf8").digest("hex");
const header = `t=${timestamp},v1=${signature}`;

console.log(`POST ${targetUrl}`);
console.log(`severity=${severity}`);

const res = await fetch(targetUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-langfuse-signature": header },
  body,
});

console.log(`status=${res.status}`);
const text = await res.text();
console.log(`response=${text}`);

if (!res.ok) {
  console.error("Non-2xx response — check the secret matches that project's LANGFUSE_ALERT_WEBHOOK_SECRET_*.");
  process.exit(1);
}
console.log("\nNow visually confirm: did the message arrive in Teams? In the test inbox?");
console.log('A "delivered" status of "skipped" above means that channel is not configured — check .env.local.');
