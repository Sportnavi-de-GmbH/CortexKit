// The weekly feedback statistics — the "Analyze" stage of the quality loop.
//
//   npm run feedback:report              (last 14 days vs the 14 before)
//   npm run feedback:report -- --days 7
//
// Reads ONLY (v3 scores + v2 observations + annotation queues); prints:
//   totals + positive rate, trend vs the prior window, environment split,
//   reason histogram with each reason's objective correlate metric,
//   review-verdict histogram, positive rate per knowledge.version_digest
//   (the before/after-a-prompt-change number), pending counts per queue,
//   a deterministic sample of plain 👍 for spot review, and the manual
//   monitor checklist.
import "../lib/load-env";

import {
  fromV3Row,
  histogram,
  rateByDigest,
  samplePlainUps,
  windowStats,
  type ScoreRow,
} from "../lib/feedback-insights";
import {
  annotationQueueId,
  FEEDBACK_SCORE,
  positiveAnnotationQueueId,
  REASON_SCORE,
} from "../lib/feedback";
import { REVIEW_VERDICT_SCORE } from "../lib/feedback-taxonomy";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to report on.");
  process.exit(3);
}

const daysArg = process.argv.indexOf("--days");
const days = daysArg >= 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 14) : 14;

const headers = langfuseHeaders();
const base = langfuseBaseUrl();
const now = new Date();
const windowFrom = new Date(now.getTime() - days * 86_400_000).toISOString();
const priorFrom = new Date(now.getTime() - 2 * days * 86_400_000).toISOString();
const nowIso = now.toISOString();

/** All feedback-related scores back to the prior window. v3 paginates by
 *  CURSOR (`meta.cursor`; a `page` param is a 400) and filters server-side
 *  with `fromTimestamp`, so both windows arrive in as few calls as possible. */
async function fetchScores(): Promise<ScoreRow[]> {
  const rows: ScoreRow[] = [];
  let cursor: string | undefined;
  for (let calls = 0; calls < 10; calls++) {
    const qs = new URLSearchParams({
      limit: "100",
      fields: "details,subject",
      fromTimestamp: priorFrom,
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

/** knowledge.version_digest from the trace's answer-delivered observation. */
async function digestForTrace(traceId: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${base}/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&name=answer-delivered&fields=basic,metadata&limit=1`,
      { headers },
    );
    if (!res.ok) return undefined;
    const obs = (((await res.json()) as { data?: Array<{ metadata?: Record<string, unknown> }> })
      .data ?? [])[0];
    const md = obs?.metadata ?? {};
    const v = md["knowledge.version_digest"] ?? (md.knowledge as { version_digest?: unknown } | undefined)?.version_digest;
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

interface QueueRow {
  id: string;
  name: string;
}

async function pendingCount(queue: QueueRow): Promise<number> {
  const res = await fetch(
    `${base}/api/public/annotation-queues/${queue.id}/items?status=PENDING&limit=100`,
    { headers },
  );
  if (!res.ok) return -1;
  const json = (await res.json()) as { data?: unknown[]; meta?: { totalItems?: number } };
  return json.meta?.totalItems ?? (json.data ?? []).length;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(0)}%`);

const scores = await fetchScores();
const current = windowStats(scores, windowFrom, nowIso);
const prior = windowStats(scores, priorFrom, windowFrom);

console.log(`Feedback report — last ${days} days (${windowFrom.slice(0, 10)} → today)`);
console.log(`Project: ${base}\n`);

console.log(
  `Votes: ${current.total}  (👍 ${current.up} · 👎 ${current.down} · ${current.withComment} with comment)`,
);
const trend =
  current.positiveRate !== null && prior.positiveRate !== null
    ? `  (prior ${days}d: ${pct(prior.positiveRate)} on ${prior.total} votes)`
    : prior.total === 0
      ? "  (no votes in the prior window)"
      : "";
console.log(`Positive rate: ${pct(current.positiveRate)}${trend}`);

for (const [env, c] of Object.entries(current.byEnvironment)) {
  const t = c.up + c.down;
  console.log(`  ${env.padEnd(12)} 👍 ${c.up} · 👎 ${c.down}  (${pct(c.up / t)})`);
}

const reasons = histogram(scores, REASON_SCORE, windowFrom, nowIso);
console.log(`\n👎 reasons (${days}d)${reasons.length === 0 ? ": none" : ":"}`);
for (const r of reasons) {
  console.log(`  ${String(r.count).padStart(3)}  ${r.value.padEnd(14)} → check ${r.correlate ?? "the trace"}`);
}

const verdicts = histogram(scores, REVIEW_VERDICT_SCORE, windowFrom, nowIso);
console.log(`\nReview verdicts (${days}d)${verdicts.length === 0 ? ": none — review the queues!" : ":"}`);
for (const v of verdicts) console.log(`  ${String(v.count).padStart(3)}  ${v.value}`);

// --- positive rate per knowledge digest (trace-precision votes only) --------
const digestVotes: Array<{ value: number; digest: string | undefined }> = [];
const traceVotes = scores.filter(
  (r) =>
    r.name === FEEDBACK_SCORE &&
    typeof r.value === "number" &&
    r.traceId &&
    (r.timestamp ?? "") >= windowFrom,
);
for (const v of traceVotes.slice(0, 25)) {
  digestVotes.push({ value: v.value as number, digest: await digestForTrace(v.traceId as string) });
}
const byDigest = rateByDigest(digestVotes);
if (byDigest.length > 0) {
  console.log(`\nPositive rate by knowledge.version_digest (${digestVotes.length} trace-precision votes):`);
  for (const d of byDigest) {
    console.log(`  ${d.digest.padEnd(18)} ${pct(d.positiveRate)}  (${d.up}/${d.total})`);
  }
  if (traceVotes.length > 25) console.log(`  (sampled the newest 25 of ${traceVotes.length})`);
}

// --- queues ----------------------------------------------------------------
// The review queues are the ones this build WRITES to (env ids), not whatever
// happens to share a name prefix — retired queues stay listed in Langfuse.
const reviewQueueIds = new Set([annotationQueueId(), positiveAnnotationQueueId()].filter(Boolean));
const qres = await fetch(`${base}/api/public/annotation-queues?limit=100`, { headers });
const queues = qres.ok
  ? ((((await qres.json()) as { data?: QueueRow[] }).data ?? []).filter((q) =>
      reviewQueueIds.has(q.id),
    ) as QueueRow[])
  : [];
console.log("\nReview queues:");
for (const q of queues) {
  const n = await pendingCount(q);
  console.log(`  ${q.name}: ${n < 0 ? "?" : n} PENDING`);
}
if (queues.length === 0) {
  console.log("  none configured — set LANGFUSE_FEEDBACK_QUEUE_ID / _POSITIVE_QUEUE_ID (npm run feedback:setup prints them)");
}

// --- weekly plain-👍 spot sample -------------------------------------------
const sample = samplePlainUps(scores, windowFrom, nowIso);
console.log(`\nPlain-👍 spot-review sample (${sample.length}):`);
for (const s of sample) {
  console.log(`  ${(s.timestamp ?? "").slice(0, 16)}  trace ${s.traceId}`);
}
if (sample.length > 0) {
  console.log("  → open each in Langfuse (Traces → paste the id); a model answer deserves");
  console.log("    a queue item in 'Review: positive examples' + verdict good-example.");
}

// --- manual monitor checklist (no monitor-update API) ----------------------
console.log(`\nMonitor checklist (manual, Langfuse UI):
  [ ] Partner project · Quality monitor: aggregation must be AVG of user-feedback, not COUNT
  [ ] FAQ project · Latency p95 monitor: filter to observation name = answer-delivered
  [ ] FAQ project · heartbeat monitor: must not be PAUSED`);
