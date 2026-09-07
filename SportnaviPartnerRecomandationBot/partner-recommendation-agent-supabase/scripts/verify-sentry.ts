/**
 * End-to-end verification: trigger every failure class exactly the way
 * agent/hooks/sentry.ts would, then PROVE each event reached Sentry by
 * fetching it back from the Sentry API.
 *
 * Run:  npx tsx --env-file=.env.local scripts/verify-sentry.ts
 *
 * HONESTY CONTRACT: a row is only VERIFIED when this script fetched the event
 * back and got a 200. Without SENTRY_AUTH_TOKEN rows stay UNVERIFIED and the
 * script says so loudly. Exit 0 = all classes produced events (and, with a
 * token, all were found).
 *
 * Ported from example/sentry-observability-agent/scripts/verify-sentry.ts.
 */
import * as Sentry from "@sentry/node";

import { classify, severityFor, fingerprintFor } from "../lib/sentry-agent";

interface Row {
  failureClass: string;
  description: string;
  eventId: string | undefined;
  verified: "VERIFIED" | "UNVERIFIED" | "NOT FOUND";
}

const DSN = process.env.SENTRY_DSN;
const ORG = process.env.SENTRY_ORG;
const PROJECT = process.env.SENTRY_PROJECT;
const TOKEN = process.env.SENTRY_AUTH_TOKEN;

if (!DSN) {
  console.error("SENTRY_DSN is not set — populate .env.local first.");
  process.exit(1);
}

Sentry.init({
  dsn: DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? "verification",
  tracesSampleRate: 1.0,
});
Sentry.setTag("eve.component", "verification");

function captureLikeTheHook(error: unknown, key: string, description: string): Row {
  const failureClass = classify(error);
  const eventId = Sentry.captureException(error, {
    level: severityFor(failureClass),
    fingerprint: fingerprintFor(failureClass, key),
    tags: {
      "eve.component": "verification",
      "failure.class": failureClass,
      verification: "true",
    },
  });
  return { failureClass, description, eventId, verified: "UNVERIFIED" };
}

const rows: Row[] = [];

rows.push(
  captureLikeTheHook(
    new Error("verify: simulated runtime failure in resolve_partners"),
    "resolve_partners",
    "Runtime exception from a tool",
  ),
);

rows.push(
  captureLikeTheHook(
    new Error("verify: supabase connection refused (simulated outage)"),
    "get_partners_by_city",
    "Integration failure (Supabase unavailable)",
  ),
);

rows.push(
  captureLikeTheHook(
    Object.assign(new Error("verify: simulated upstream provider failure"), { status: 503 }),
    "model_call",
    "External API failure (upstream 5xx)",
  ),
);

{
  const error = new Error("verify: the turn failed");
  error.name = "turn_error";
  const eventId = Sentry.captureException(error, {
    level: severityFor("agent"),
    fingerprint: fingerprintFor("agent", "turn_error"),
    tags: { "eve.component": "verification", "failure.class": "agent", verification: "true" },
  });
  rows.push({
    failureClass: "agent",
    description: "Agent failure (turn.failed)",
    eventId,
    verified: "UNVERIFIED",
  });
}

rows.push({
  failureClass: "performance",
  description: "Performance issue (latency budget exceeded)",
  eventId: Sentry.captureMessage("verify: agent operation exceeded its latency budget", {
    level: severityFor("performance"),
    fingerprint: fingerprintFor("performance", "verify:performance"),
    tags: { "eve.component": "verification", "failure.class": "performance", verification: "true" },
  }),
  verified: "UNVERIFIED",
});

rows.push({
  failureClass: "unexpected",
  description: "Unexpected behavior (malformed result)",
  eventId: Sentry.captureMessage("verify: agent returned a malformed result", {
    level: severityFor("unexpected"),
    fingerprint: fingerprintFor("unexpected", "verify:unexpected"),
    tags: { "eve.component": "verification", "failure.class": "unexpected", verification: "true" },
  }),
  verified: "UNVERIFIED",
});

await Sentry.flush(10_000);

/** EU orgs live in the EU silo; derive the API host from the DSN. */
function apiBaseUrl(dsn: string): string {
  const host = dsn.split("@")[1]?.split("/")[0] ?? "";
  const region = /\.ingest\.([a-z]{2})\.sentry\.io$/.exec(host)?.[1];
  return region && region !== "us" ? `https://${region}.sentry.io` : "https://sentry.io";
}

const API_BASE = apiBaseUrl(DSN);

async function findEvent(eventId: string): Promise<boolean> {
  const url = `${API_BASE}/api/0/projects/${ORG}/${PROJECT}/events/${eventId}/`;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (response.ok) return true;
    if (response.status === 401 || response.status === 403) {
      console.error(`\nSentry API rejected the token (HTTP ${response.status}).`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

const canVerify = Boolean(TOKEN && ORG && PROJECT);

if (canVerify) {
  console.log("Confirming events against the Sentry API (this takes a few seconds)…\n");
  for (const row of rows) {
    if (!row.eventId) continue;
    row.verified = (await findEvent(row.eventId)) ? "VERIFIED" : "NOT FOUND";
  }
}

console.log("\nFailure class   Status       Event ID                          Description");
console.log("-".repeat(100));
for (const row of rows) {
  console.log(
    `${row.failureClass.padEnd(15)} ${row.verified.padEnd(12)} ` +
      `${(row.eventId ?? "— none —").padEnd(33)} ${row.description}`,
  );
}

const missing = rows.filter((r) => !r.eventId);
const notFound = rows.filter((r) => r.verified === "NOT FOUND");

console.log();
if (!canVerify) {
  console.log("UNVERIFIED: set SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT to make this an actual check.");
}
if (missing.length > 0) console.error(`FAIL: ${missing.length} class(es) produced no event id.`);
if (notFound.length > 0) console.error(`FAIL: ${notFound.length} event(s) never found in Sentry.`);
if (missing.length === 0 && notFound.length === 0) {
  console.log(
    canVerify
      ? "PASS: every failure class produced an event and every event was found in Sentry."
      : "PARTIAL: every class produced an event id; delivery unconfirmed.",
  );
}

process.exit(missing.length + notFound.length > 0 ? 1 : 0);
