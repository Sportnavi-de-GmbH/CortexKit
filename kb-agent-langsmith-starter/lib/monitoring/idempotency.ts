// Dedup for the alert-webhook relay, keyed on Langfuse's webhook envelope `id`.
//
// Langfuse retries a webhook delivery with exponential backoff until it gets a 2xx
// (langfuse.com/docs/metrics/features/alerts). Our relay always returns 200 once the
// signature is verified (lib/monitoring/relay.ts), so a retry of the SAME event must not
// re-notify Teams/email. Self-contained rather than reusing lib/langfuse.ts's fileStore —
// that module's header scopes it to tracing concerns; duplicating ~20 lines keeps this
// feature independently deployable/removable (smallest-change discipline, CLAUDE.md §14).

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".data/alert-webhook-ids";
const TTL_MS = 7 * 24 * 60 * 60_000; // 7 days — generous vs. Langfuse's retry window

const seen = new Map<string, number>();

function safeName(eventId: string): string {
  return eventId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function prune(now: number): void {
  for (const [id, at] of seen) {
    if (now - at > TTL_MS) seen.delete(id);
  }
}

export function alreadyDelivered(eventId: string): boolean {
  const now = Date.now();
  prune(now);
  if (seen.has(eventId)) return true;
  try {
    const stat = statSync(join(DIR, safeName(eventId)));
    return now - stat.mtimeMs < TTL_MS;
  } catch {
    return false;
  }
}

export function markDelivered(eventId: string): void {
  const now = Date.now();
  seen.set(eventId, now);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, safeName(eventId)), String(now));
  } catch {
    // best-effort — in-memory map still covers the common single-instance case
  }
}
