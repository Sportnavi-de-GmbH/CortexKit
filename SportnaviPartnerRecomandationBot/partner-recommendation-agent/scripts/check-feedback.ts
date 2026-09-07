// "Is user feedback actually working?" — answered by reading Langfuse BACK.
//
// Run this after clicking 👍/👎 in the widget. It reads the scores out of
// Langfuse (not out of our own logs) and prints them in plain language, so a
// green result means the data really landed rather than that a request returned
// 200. Langfuse answers on enqueue, so a 200 alone proves nothing.
//
//   npm run feedback:check              # last 20 feedback scores, this project
//   npm run feedback:check -- --trace <traceId>
//   npm run feedback:check -- --session <eve session id>
//
// NOTE: reads use /api/public/v3/scores with `fields=details`. On this v4
// `events_only` instance /scores and /v2/scores return 404, and without
// `fields=details` the comment and metadata come back null even though they are
// stored. Both facts are measured, not guessed.
import "../lib/load-env";

import { FEEDBACK_SCORE, REASONS, REASON_SCORE } from "../lib/feedback";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured in this environment — nothing to check.");
  console.error("Need LANGFUSE_BASE_URL + LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY.");
  process.exit(3);
}

const traceId = flag("trace");
const sessionId = flag("session");

const query = new URLSearchParams({ fields: "details", limit: "50" });
if (traceId) query.set("traceId", traceId);
if (sessionId) query.set("sessionId", sessionId);

interface ScoreRow {
  id: string;
  name: string;
  value: number | string;
  comment?: string | null;
  metadata?: Record<string, unknown> | null;
  environment?: string;
  timestamp?: string;
  createdAt?: string;
}

const url = `${langfuseBaseUrl()}/api/public/v3/scores?${query}`;
const res = await fetch(url, { headers: langfuseHeaders() });
if (!res.ok) {
  console.error(`Could not read scores: HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const rows = ((await res.json()) as { data?: ScoreRow[] }).data ?? [];
const thumbs = rows.filter((r) => r.name === FEEDBACK_SCORE);
const reasons = rows.filter((r) => r.name === REASON_SCORE);

console.log(`\nLangfuse: ${langfuseBaseUrl()}`);
console.log(`Scope:    ${traceId ? `trace ${traceId}` : sessionId ? `session ${sessionId}` : "most recent"}\n`);

if (thumbs.length === 0) {
  console.log("No feedback found yet.");
  console.log("");
  console.log("If you just clicked a thumb, wait ~15s and re-run — ingestion is");
  console.log("asynchronous. If it stays empty, check in this order:");
  console.log("  1. Did you rate a COMPLETED answer? Thumbs only appear once it finishes.");
  console.log("  2. Any red error in the browser console when you clicked?");
  console.log("  3. Is this the right project? Partner feedback lands in 'Navio — Partner',");
  console.log("     FAQ feedback in 'Navio — FAQ' — run this from the matching service.");
  process.exit(1);
}

const label = (code: unknown): string =>
  REASONS.find((r) => r.code === code)?.de ?? String(code ?? "—");

// Pair each thumb with its reason score by the shared id suffix.
const reasonFor = (thumbId: string): string | undefined => {
  const r = reasons.find((x) => x.id === `${thumbId}-reason`);
  return r ? String(r.value) : undefined;
};

let up = 0;
let down = 0;
console.log(`${thumbs.length} feedback entr${thumbs.length === 1 ? "y" : "ies"}:\n`);
for (const t of thumbs) {
  const positive = Number(t.value) === 1;
  positive ? up++ : down++;
  const meta = (t.metadata ?? {}) as Record<string, unknown>;
  const when = (t.timestamp ?? t.createdAt ?? "").slice(0, 19).replace("T", " ");
  const reason = reasonFor(t.id) ?? meta.reason;

  console.log(`  ${positive ? "THUMBS UP  " : "THUMBS DOWN"}  ${when}  [${t.environment ?? "?"}]`);
  console.log(`     surface : ${String(meta.surface ?? "?")}   turn: ${String(meta.turnId ?? "?")}`);
  if (!positive) {
    console.log(`     reason  : ${reason ? `${reason} (${label(reason)})` : "— none given"}`);
    console.log(`     comment : ${t.comment ? `"${t.comment}"` : "— none written"}`);
  }
  console.log("");
}

const rate = ((up / thumbs.length) * 100).toFixed(0);
console.log(`Satisfaction: ${up} up / ${down} down  =  ${rate}% positive`);

// The reason breakdown — the thing the CATEGORICAL score exists to make cheap.
if (reasons.length > 0) {
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const k = String(r.value);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  console.log("\nReasons given:");
  for (const [code, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${code} (${label(code)})`);
  }
}

console.log("\nOK — feedback is reaching Langfuse.");
