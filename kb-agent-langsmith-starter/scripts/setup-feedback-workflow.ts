// Idempotent setup for the FULL feedback quality loop (supersedes
// setup-feedback-scores.ts, which stays for history):
//
//   configs : user-feedback (numeric 0..1) · feedback-reason (8 visitor codes)
//             · review-verdict (7 reviewer classifications)
//   queues  : "Feedback — Negative Review"    (reason + verdict attached)
//             "Feedback — Positive Examples"  (verdict attached)
//   migrate : PENDING TRACE items from the legacy "Negative Feedback Review"
//             queue move into the new negative queue — skipping duplicates and
//             traces whose CURRENT thumb is 👍 (a 👎→👍 flip deliberately left
//             its item behind; a fresh queue should not inherit that noise).
//
// Idempotency is list-then-create everywhere: Langfuse silently creates
// duplicate names (it did — the FAQ project carries permanent duplicate
// configs), and score configs have no update/delete REST endpoint.
//
// ⚠ PICKING AMONG DUPLICATES: the earliest-created config is NOT automatically
// safe — in the FAQ project the earliest `user-feedback` is malformed
// (minValue/maxValue null). This script picks the earliest WELL-FORMED config
// for each name and prints exactly which ids to put in the environment.
//
// Run once per Langfuse project (each build's env selects the project):
//   npx tsx scripts/setup-feedback-workflow.ts
import "../lib/load-env.ts";

import { FEEDBACK_SCORE, REASON_SCORE } from "../lib/feedback.ts";
import { REASONS, REVIEW_VERDICTS, REVIEW_VERDICT_SCORE } from "../lib/feedback-taxonomy.ts";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse.ts";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to set up.");
  process.exit(3);
}

const headers = { ...langfuseHeaders(), "Content-Type": "application/json" };
const base = langfuseBaseUrl();
const configsBase = `${base}/api/public/score-configs`;
const queuesBase = `${base}/api/public/annotation-queues`;

const NEGATIVE_QUEUE = "Feedback — Negative Review";
const POSITIVE_QUEUE = "Feedback — Positive Examples";
const LEGACY_QUEUE = "Negative Feedback Review";

interface ConfigRow {
  id: string;
  name: string;
  createdAt?: string;
  dataType?: string;
  minValue?: number | null;
  maxValue?: number | null;
  categories?: Array<{ label: string; value: number }> | null;
}

/** A config is usable only when its SHAPE matches what the writers send. */
function wellFormed(c: ConfigRow): boolean {
  if (c.name === FEEDBACK_SCORE) {
    return c.dataType === "NUMERIC" && c.minValue === 0 && c.maxValue === 1;
  }
  if (c.name === REASON_SCORE) {
    const labels = new Set((c.categories ?? []).map((x) => x.label));
    return c.dataType === "CATEGORICAL" && REASONS.every((r) => labels.has(r.code));
  }
  if (c.name === REVIEW_VERDICT_SCORE) {
    const labels = new Set((c.categories ?? []).map((x) => x.label));
    return c.dataType === "CATEGORICAL" && REVIEW_VERDICTS.every((v) => labels.has(v.value));
  }
  return true;
}

async function listConfigs(): Promise<ConfigRow[]> {
  const res = await fetch(`${configsBase}?limit=100`, { headers });
  if (!res.ok) throw new Error(`score-configs list: ${res.status}`);
  return ((await res.json()) as { data?: ConfigRow[] }).data ?? [];
}

async function ensureConfig(body: Record<string, unknown>): Promise<string> {
  const name = body.name as string;
  const matches = (await listConfigs()).filter((c) => c.name === name);
  const good = matches
    .filter(wellFormed)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  if (good.length > 0) {
    const skipped = matches.length - good.length;
    console.log(
      `PASS  exists   ${name}  configId=${good[0].id}` +
        (skipped > 0 ? `  (${skipped} MALFORMED duplicate(s) ignored)` : "") +
        (good.length > 1 ? `  (${good.length - 1} well-formed duplicate(s) ignored)` : ""),
    );
    return good[0].id;
  }
  const res = await fetch(configsBase, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !json.id) {
    console.error(`FAIL  ${name}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    process.exitCode = 1;
    return "";
  }
  console.log(`PASS  created  ${name}  configId=${json.id}`);
  return json.id;
}

// REST field names (minValue/maxValue/categories), NOT the MCP tool's spelling.
const feedbackConfigId = await ensureConfig({
  name: FEEDBACK_SCORE,
  dataType: "NUMERIC",
  minValue: 0,
  maxValue: 1,
  description: "Visitor rating of one answer. 1 = thumbs up, 0 = thumbs down.",
});

const reasonConfigId = await ensureConfig({
  name: REASON_SCORE,
  dataType: "CATEGORICAL",
  categories: REASONS.map((r, i) => ({ label: r.code, value: i })),
  description: `Why a visitor rated an answer negatively (thumbs down only). ${REASONS.map(
    (r) => `${r.code} = ${r.de}`,
  ).join(" · ")}`,
});

const verdictConfigId = await ensureConfig({
  name: REVIEW_VERDICT_SCORE,
  dataType: "CATEGORICAL",
  categories: REVIEW_VERDICTS.map((v, i) => ({ label: v.value, value: i })),
  description: `Human reviewer's classification of a feedback item, set from the annotation queues. ${REVIEW_VERDICTS.map(
    (v) => `${v.value} = ${v.en}`,
  ).join(" · ")}`,
});

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  name: string;
}

async function findQueue(name: string): Promise<QueueRow | undefined> {
  const res = await fetch(`${queuesBase}?limit=100`, { headers });
  if (!res.ok) return undefined;
  return (((await res.json()) as { data?: QueueRow[] }).data ?? []).find((q) => q.name === name);
}

async function ensureQueue(
  name: string,
  description: string,
  scoreConfigIds: string[],
): Promise<string> {
  const existing = await findQueue(name);
  if (existing) {
    console.log(`PASS  exists   queue "${name}"  queueId=${existing.id}`);
    return existing.id;
  }
  const res = await fetch(queuesBase, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, description, scoreConfigIds }),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !json.id) {
    console.error(`FAIL  queue "${name}": ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    process.exitCode = 1;
    return "";
  }
  console.log(`PASS  created  queue "${name}"  queueId=${json.id}`);
  return json.id;
}

const negativeQueueId = await ensureQueue(
  NEGATIVE_QUEUE,
  "Every 👎 lands here as PENDING. Review: open the item, read the trace next to " +
    "the visitor's reason + comment, set ONE review-verdict, optionally leave a " +
    "Comment, mark COMPLETED. feedback:promote turns completed verdicts into " +
    "datasets (incorrect/partially-correct → Regressions).",
  [reasonConfigId, verdictConfigId].filter(Boolean),
);

const positiveQueueId = await ensureQueue(
  POSITIVE_QUEUE,
  "Every 👍 that carries a visitor comment lands here as PENDING (plain 👍 stays " +
    "statistics-only; the weekly report samples those). Review and set " +
    "review-verdict=good-example to have feedback:promote add the answer to the " +
    "'Feedback — Golden Answers' dataset.",
  [verdictConfigId].filter(Boolean),
);

// ---------------------------------------------------------------------------
// Migration: legacy queue → new negative queue
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  objectId: string;
  objectType: string;
  status: string;
}

async function listItems(queueId: string): Promise<ItemRow[]> {
  const res = await fetch(`${queuesBase}/${queueId}/items?limit=100`, { headers });
  if (!res.ok) return [];
  return (((await res.json()) as { data?: ItemRow[] }).data ?? []) as ItemRow[];
}

/** Latest user-feedback value per trace, so flipped-to-👍 items are not
 *  migrated. Volume is tiny (tens), one page is plenty. NOTE: v3 rows carry
 *  the trace linkage in `subject` (kind + id), present only when the request
 *  asks for `fields=subject` — without it every vote looks session-less. */
async function currentThumbByTrace(): Promise<Map<string, number>> {
  const res = await fetch(
    `${base}/api/public/v3/scores?name=${encodeURIComponent(FEEDBACK_SCORE)}&limit=100&fields=subject`,
    { headers },
  );
  if (!res.ok) return new Map();
  const rows = (((await res.json()) as { data?: Array<Record<string, unknown>> }).data ?? []) as Array<{
    subject?: { kind?: string; id?: string } | null;
    value?: number;
    timestamp?: string;
  }>;
  const byTrace = new Map<string, { value: number; ts: string }>();
  for (const r of rows) {
    const traceId = r.subject?.kind === "trace" ? r.subject.id : undefined;
    if (!traceId || typeof r.value !== "number") continue;
    const prev = byTrace.get(traceId);
    const ts = r.timestamp ?? "";
    if (!prev || ts > prev.ts) byTrace.set(traceId, { value: r.value, ts });
  }
  return new Map([...byTrace.entries()].map(([k, v]) => [k, v.value]));
}

const legacy = await findQueue(LEGACY_QUEUE);
if (legacy && negativeQueueId) {
  const [legacyItems, newItems, thumbs] = await Promise.all([
    listItems(legacy.id),
    listItems(negativeQueueId),
    currentThumbByTrace(),
  ]);
  const already = new Set(newItems.map((i) => `${i.objectType}:${i.objectId}`));
  const seen = new Set<string>();
  let moved = 0;
  let skipped = 0;
  for (const item of legacyItems) {
    const key = `${item.objectType}:${item.objectId}`;
    const flippedUp = item.objectType === "TRACE" && thumbs.get(item.objectId) === 1;
    if (
      item.status !== "PENDING" ||
      item.objectType === "OBSERVATION" || // bogus historical entry
      already.has(key) ||
      seen.has(key) || // duplicate rows in the legacy queue itself
      flippedUp
    ) {
      skipped++;
      continue;
    }
    seen.add(key);
    const res = await fetch(`${queuesBase}/${negativeQueueId}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ objectId: item.objectId, objectType: item.objectType }),
    });
    if (res.ok) moved++;
  }
  console.log(
    `PASS  migrated ${moved} PENDING item(s) from "${LEGACY_QUEUE}" (${skipped} skipped: done/duplicate/flipped/bogus)`,
  );
  console.log(
    `      the legacy queue is left in place for history — review anything left there once, then ignore it`,
  );
} else if (!legacy) {
  console.log(`PASS  no legacy "${LEGACY_QUEUE}" queue — nothing to migrate`);
}

// ---------------------------------------------------------------------------

console.log(`\nProject: ${base}`);
console.log("Run this once per project that receives feedback (FAQ, Partner).");
console.log("\nSet these in .env.local AND on the Vercel project (then redeploy):");
console.log(`LANGFUSE_FEEDBACK_SCORE_CONFIG_ID=${feedbackConfigId}`);
console.log(`LANGFUSE_REASON_SCORE_CONFIG_ID=${reasonConfigId}`);
console.log(`LANGFUSE_REVIEW_VERDICT_CONFIG_ID=${verdictConfigId}`);
console.log(`LANGFUSE_FEEDBACK_QUEUE_ID=${negativeQueueId}`);
console.log(`LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID=${positiveQueueId}`);
