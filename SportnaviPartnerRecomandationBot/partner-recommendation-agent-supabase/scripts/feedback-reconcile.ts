// Upgrade SESSION-precision feedback to TRACE precision, after the fact.
//
//   npm run feedback:reconcile               (writes)
//   npm run feedback:reconcile -- --dry-run  (prints what it would do)
//   npm run feedback:reconcile -- --days 30
//
// A vote lands at session precision when the serving instance had no
// (session, turn) → trace ref AND the turn's spans were not ingested yet
// (typically: the visitor clicked within seconds of the answer). Once the
// trace is queryable, the turn ordinal names it (traceForTurn). The Langfuse
// API cannot MOVE a score's subject — a merge POST keeps the old subject
// (measured 2026-09-08) — so each score is deleted and re-created with the same
// id; the original timestamp is preserved in metadata.originalTimestamp and
// honoured by the statistics. Queue items follow: a TRACE item replaces the
// PENDING SESSION item. Run before feedback:report; idempotent.
import "../lib/load-env";

import { traceForTurn } from "../lib/feedback-insights";
import { FEEDBACK_SCORE, REASON_SCORE } from "../lib/feedback";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to reconcile.");
  process.exit(3);
}

const dryRun = process.argv.includes("--dry-run");
const daysArg = process.argv.indexOf("--days");
const days = daysArg >= 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 14) : 14;
const fromTimestamp = new Date(Date.now() - days * 86_400_000).toISOString();

const base = langfuseBaseUrl();
const headers = { ...langfuseHeaders(), "Content-Type": "application/json" };

interface RawScore {
  id: string;
  name: string;
  value: number | string;
  dataType: string;
  comment?: string | null;
  metadata?: Record<string, unknown> | null;
  environment?: string;
  timestamp?: string;
  configId?: string | null;
  subject?: { kind: string; id: string } | null;
}

/** All session-precision feedback scores in the window (cursor-paged). */
async function sessionScores(): Promise<RawScore[]> {
  const out: RawScore[] = [];
  let cursor: string | undefined;
  for (let calls = 0; calls < 10; calls++) {
    const qs = new URLSearchParams({ limit: "100", fields: "details,subject", fromTimestamp });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${base}/api/public/v3/scores?${qs}`, { headers });
    if (!res.ok) throw new Error(`v3/scores: ${res.status}`);
    const json = (await res.json()) as { data?: RawScore[]; meta?: { cursor?: string | null } };
    out.push(
      ...(json.data ?? []).filter(
        (r) =>
          r.subject?.kind === "session" && (r.name === FEEDBACK_SCORE || r.name === REASON_SCORE),
      ),
    );
    cursor = json.meta?.cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

const obsCache = new Map<string, Array<{ traceId?: string; startTime?: string }>>();
async function observationsOf(sessionId: string) {
  const hit = obsCache.get(sessionId);
  if (hit) return hit;
  const qs = new URLSearchParams({ sessionId, fields: "core,basic,time", limit: "100" });
  const res = await fetch(`${base}/api/public/v2/observations?${qs}`, { headers });
  const data = res.ok
    ? (((await res.json()) as { data?: Array<{ traceId?: string; startTime?: string }> }).data ?? [])
    : [];
  obsCache.set(sessionId, data);
  return data;
}

const scores = await sessionScores();
console.log(`${scores.length} session-precision score(s) in the last ${days} days`);

/** session → trace ids that received an upgraded 👎 / commented 👍, for the queues. */
const negativeTraces = new Map<string, Set<string>>();
const positiveTraces = new Map<string, Set<string>>();
let upgraded = 0;
let pending = 0;
let failed = 0;

for (const s of scores) {
  const sessionId = s.subject!.id;
  const turnId = typeof s.metadata?.turnId === "string" ? s.metadata.turnId : undefined;
  const traceId = turnId ? traceForTurn(await observationsOf(sessionId), turnId) : undefined;
  if (!traceId) {
    pending++;
    console.log(`  WAIT  ${s.id}: trace for ${turnId ?? "(no turnId)"} not ingested yet`);
    continue;
  }
  if (s.name === FEEDBACK_SCORE) {
    const bucket = s.value === 0 ? negativeTraces : (s.comment ?? "") !== "" ? positiveTraces : undefined;
    if (bucket) (bucket.get(sessionId) ?? bucket.set(sessionId, new Set()).get(sessionId)!).add(traceId);
  }
  if (dryRun) {
    upgraded++;
    console.log(`  DRY   ${s.id} → trace ${traceId}`);
    continue;
  }
  const del = await fetch(`${base}/api/public/scores/${s.id}`, { method: "DELETE", headers });
  if (!del.ok && del.status !== 404) {
    failed++;
    console.error(`  FAIL  ${s.id}: delete ${del.status}`);
    continue;
  }
  const res = await fetch(`${base}/api/public/scores`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: s.id,
      traceId,
      name: s.name,
      value: s.value,
      dataType: s.dataType,
      comment: s.comment ?? "",
      environment: s.environment,
      source: "API",
      metadata: {
        ...(s.metadata ?? {}),
        originalTimestamp: s.timestamp,
        reconciledAt: new Date().toISOString(),
      },
      ...(s.configId ? { configId: s.configId } : {}),
    }),
  });
  if (res.ok) {
    upgraded++;
    console.log(`  PASS  ${s.id} → trace ${traceId}`);
  } else {
    failed++;
    console.error(`  FAIL  ${s.id}: re-create ${res.status} (score was deleted — re-run)`);
  }
}

// --- queues: TRACE item replaces the PENDING SESSION item -------------------
interface QueueRow {
  id: string;
  name: string;
}
interface ItemRow {
  id: string;
  objectId: string;
  objectType: string;
  status: string;
}

const qres = await fetch(`${base}/api/public/annotation-queues?limit=100`, { headers });
const queues = qres.ok
  ? ((((await qres.json()) as { data?: QueueRow[] }).data ?? []) as QueueRow[])
  : [];
let itemsMoved = 0;
for (const q of queues) {
  const bucket = q.name === "Feedback — Negative Review" ? negativeTraces
    : q.name === "Feedback — Positive Examples" ? positiveTraces
      : undefined;
  if (!bucket || bucket.size === 0) continue;
  const ires = await fetch(`${base}/api/public/annotation-queues/${q.id}/items?limit=100`, { headers });
  const items = ires.ok ? ((((await ires.json()) as { data?: ItemRow[] }).data ?? []) as ItemRow[]) : [];
  const have = new Set(items.map((i) => `${i.objectType}:${i.objectId}`));
  for (const [sessionId, traces] of bucket) {
    const sessionItems = items.filter(
      (i) => i.objectType === "SESSION" && i.objectId === sessionId && i.status === "PENDING",
    );
    if (sessionItems.length === 0) continue; // never queued, or already reviewed
    for (const traceId of traces) {
      if (have.has(`TRACE:${traceId}`)) continue;
      if (dryRun) {
        console.log(`  DRY   queue "${q.name}": + TRACE ${traceId}, - SESSION ${sessionId}`);
        continue;
      }
      const c = await fetch(`${base}/api/public/annotation-queues/${q.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ objectId: traceId, objectType: "TRACE" }),
      });
      if (c.ok) {
        have.add(`TRACE:${traceId}`);
        itemsMoved++;
      }
    }
    if (!dryRun) {
      for (const it of sessionItems) {
        await fetch(`${base}/api/public/annotation-queues/${q.id}/items/${it.id}`, {
          method: "DELETE",
          headers,
        });
      }
    }
  }
}

console.log(
  `\n${dryRun ? "[dry-run] would upgrade" : "Upgraded"} ${upgraded} score(s) · ${pending} not ingested yet · ${failed} failed · ${itemsMoved} queue item(s) moved to trace`,
);
if (pending > 0) console.log("→ re-run in a few minutes for the ones still ingesting.");
if (failed > 0) process.exitCode = 1;
