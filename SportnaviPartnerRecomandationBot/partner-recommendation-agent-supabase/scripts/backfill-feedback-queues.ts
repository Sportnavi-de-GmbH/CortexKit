// Make the review queues match the votes that already exist.
//
//   npm run feedback:backfill            last 30 days, writes
//   npm run feedback:backfill -- --dry-run
//   npm run feedback:backfill -- --days 90
//
// Routing happens live on every click (lib/feedback.ts), but three things put
// history out of step with that rule:
//   * votes cast before 2026-09-09, when a comment-less 👍 was never queued;
//   * items removed by hand in the UI while their vote still stands;
//   * a queue push that failed transiently (the score write is independent).
//
// This script closes the gap: for every `user-feedback` score in the window it
// ensures ONE item exists in the queue its thumb belongs to. It is careful in
// three ways — it never touches COMPLETED items (a review that happened is a
// fact), it never creates a duplicate (it asks the queue first), and it never
// removes anything. Idempotent: a second run reports 0 created.
import "../lib/load-env";

import { fromV3Row, type ScoreRow } from "../lib/feedback-insights";
import { annotationQueueId, FEEDBACK_SCORE, positiveAnnotationQueueId } from "../lib/feedback";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to backfill.");
  process.exit(3);
}

const dryRun = process.argv.includes("--dry-run");
const daysArg = process.argv.indexOf("--days");
const days = daysArg >= 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 30) : 30;
const fromTimestamp = new Date(Date.now() - days * 86_400_000).toISOString();

const base = langfuseBaseUrl();
const headers = { ...langfuseHeaders(), "Content-Type": "application/json" };
const NEGATIVE = annotationQueueId();
const POSITIVE = positiveAnnotationQueueId();

if (!NEGATIVE || !POSITIVE) {
  console.error(
    "Both queue ids must be set (LANGFUSE_FEEDBACK_QUEUE_ID, LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID).",
  );
  process.exit(3);
}

/** Every thumb score in the window (cursor-paged — v3 has no `page`). */
async function votes(): Promise<ScoreRow[]> {
  const rows: ScoreRow[] = [];
  let cursor: string | undefined;
  for (let calls = 0; calls < 50; calls++) {
    const qs = new URLSearchParams({
      limit: "100",
      fields: "details,subject",
      name: FEEDBACK_SCORE,
      fromTimestamp,
    });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${base}/api/public/v3/scores?${qs}`, { headers });
    if (!res.ok) throw new Error(`v3/scores: ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<Record<string, unknown>>;
      meta?: { cursor?: string | null };
    };
    rows.push(...(json.data ?? []).map(fromV3Row));
    cursor = json.meta?.cursor ?? undefined;
    if (!cursor) break;
  }
  return rows;
}

interface Item {
  id: string;
  objectId: string;
  objectType: string;
  status: string;
}

/** One read per queue, then everything is decided in memory. */
async function itemsOf(queueId: string): Promise<Item[]> {
  const all: Item[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${base}/api/public/annotation-queues/${queueId}/items?limit=100&page=${page}`,
      { headers },
    );
    if (!res.ok) break;
    const json = (await res.json()) as { data?: Item[]; meta?: { totalPages?: number } };
    all.push(...(json.data ?? []));
    if (page >= (json.meta?.totalPages ?? page)) break;
  }
  return all;
}

const [negItems, posItems, scores] = await Promise.all([
  itemsOf(NEGATIVE),
  itemsOf(POSITIVE),
  votes(),
]);

const key = (t: string, id: string) => `${t}:${id}`;
const present = {
  [NEGATIVE]: new Set(negItems.map((i) => key(i.objectType, i.objectId))),
  [POSITIVE]: new Set(posItems.map((i) => key(i.objectType, i.objectId))),
};

let created = 0;
let already = 0;
let skippedNoSubject = 0;

for (const s of scores) {
  if (typeof s.value !== "number") continue;
  // The queue item points at whatever the score points at: its trace when the
  // vote reached trace precision, otherwise its session.
  const objectType = s.traceId ? "TRACE" : s.sessionId ? "SESSION" : undefined;
  const objectId = s.traceId ?? s.sessionId;
  if (!objectType || !objectId) {
    skippedNoSubject++;
    continue;
  }
  const queueId = s.value === 0 ? NEGATIVE : POSITIVE;
  if (present[queueId].has(key(objectType, objectId))) {
    already++;
    continue;
  }
  const thumb = s.value === 0 ? "👎" : "👍";
  if (dryRun) {
    created++;
    console.log(`  DRY   ${thumb} ${objectType} ${objectId} → ${queueId === NEGATIVE ? "negative" : "positive"}`);
    present[queueId].add(key(objectType, objectId)); // so a re-vote row is not counted twice
    continue;
  }
  const res = await fetch(`${base}/api/public/annotation-queues/${queueId}/items`, {
    method: "POST",
    headers,
    body: JSON.stringify({ objectId, objectType }),
  });
  if (res.ok) {
    created++;
    present[queueId].add(key(objectType, objectId));
    console.log(`  PASS  ${thumb} ${objectType} ${objectId} → ${queueId === NEGATIVE ? "negative" : "positive"}`);
  } else {
    process.exitCode = 1;
    console.error(`  FAIL  ${objectId}: ${res.status}`);
  }
}

console.log(
  `\n${scores.length} vote(s) in the last ${days} days · ` +
    `${dryRun ? "would create" : "created"} ${created} queue item(s) · ` +
    `${already} already queued (any status) · ${skippedNoSubject} without a subject`,
);
