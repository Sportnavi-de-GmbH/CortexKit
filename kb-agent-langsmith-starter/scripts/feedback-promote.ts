// Promote reviewed feedback into Langfuse datasets — the bridge from human
// review to the eval harness.
//
//   npm run feedback:promote               (writes)
//   npm run feedback:promote -- --dry-run  (prints what it would do)
//
// Reads COMPLETED items from the two "Feedback — …" annotation queues, joins
// each to its review-verdict ANNOTATION score, and routes by verdict:
//   good-example                 → dataset "Feedback — Golden Answers"
//   incorrect/partially-correct  → dataset "Feedback — Regressions"
//   everything else              → left alone (verdict says fix data/UX, not prompt)
// Item input/expectedOutput come from the trace's answer-delivered observation.
// Idempotent: dataset item id = fb-<traceId>, so re-running upserts in place.
import "../lib/load-env.ts";

import {
  datasetForVerdict,
  datasetItemId,
  fromV3Row,
  verdictByTrace,
} from "../lib/feedback-insights.ts";
import { annotationQueueId, positiveAnnotationQueueId } from "../lib/feedback.ts";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse.ts";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to promote.");
  process.exit(3);
}

const dryRun = process.argv.includes("--dry-run");
const headers = { ...langfuseHeaders(), "Content-Type": "application/json" };
const base = langfuseBaseUrl();

interface ItemRow {
  id: string;
  objectId: string;
  objectType: string;
  status: string;
}

const qres = await fetch(`${base}/api/public/annotation-queues?limit=100`, { headers });
if (!qres.ok) throw new Error(`annotation-queues list: ${qres.status}`);
// Only the queues this build writes to (env ids) — retired queues stay listed.
const reviewQueueIds = new Set([annotationQueueId(), positiveAnnotationQueueId()].filter(Boolean));
const queues = (((await qres.json()) as { data?: Array<{ id: string; name: string }> }).data ?? [])
  .filter((q) => reviewQueueIds.has(q.id));
if (queues.length === 0) {
  console.error(
    "No review queues configured — set LANGFUSE_FEEDBACK_QUEUE_ID / _POSITIVE_QUEUE_ID (npm run feedback:setup prints them).",
  );
  process.exit(3);
}

const completed: ItemRow[] = [];
for (const q of queues) {
  const res = await fetch(
    `${base}/api/public/annotation-queues/${q.id}/items?status=COMPLETED&limit=100`,
    { headers },
  );
  if (!res.ok) continue;
  completed.push(...((((await res.json()) as { data?: ItemRow[] }).data ?? []) as ItemRow[]));
}
console.log(`${completed.length} COMPLETED queue item(s) across ${queues.length} queue(s)`);

// Latest review-verdict per trace (ANNOTATION scores, one page is plenty at
// current volume — the verdicts are set by hand).
const sres = await fetch(
  `${base}/api/public/v3/scores?name=review-verdict&limit=100&fields=details,subject`,
  { headers },
);
const verdictScores = sres.ok
  ? (((await sres.json()) as { data?: Array<Record<string, unknown>> }).data ?? []).map(fromV3Row)
  : [];
const verdicts = verdictByTrace(verdictScores);

/** Question + answer from the trace's answer-delivered summary observation. */
async function traceIo(
  traceId: string,
): Promise<{ input: unknown; output: unknown; metadata: Record<string, unknown> } | null> {
  const res = await fetch(
    `${base}/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&name=answer-delivered&fields=basic,io,metadata&limit=1`,
    { headers },
  );
  if (!res.ok) return null;
  const obs = (((await res.json()) as {
    data?: Array<{ input?: unknown; output?: unknown; metadata?: Record<string, unknown> }>;
  }).data ?? [])[0];
  if (!obs || obs.input == null || obs.output == null) return null;
  return { input: obs.input, output: obs.output, metadata: obs.metadata ?? {} };
}

const ensuredDatasets = new Set<string>();
async function ensureDataset(name: string): Promise<void> {
  if (ensuredDatasets.has(name) || dryRun) return;
  // POST /v2/datasets is an upsert by name per the API spec.
  const res = await fetch(`${base}/api/public/v2/datasets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      description:
        name.includes("Golden")
          ? "Reviewer-approved model answers (review-verdict = good-example). Reference set for evals."
          : "Answers a reviewer marked incorrect or partially-correct. Every prompt/KB change must re-run these.",
    }),
  });
  if (!res.ok) throw new Error(`upsert dataset "${name}": ${res.status}`);
  ensuredDatasets.add(name);
}

let promoted = 0;
let skippedNoVerdict = 0;
let skippedNotPromotable = 0;
let skippedSession = 0;
let skippedNoIo = 0;

for (const item of completed) {
  if (item.objectType !== "TRACE") {
    // Session-precision votes cannot name the answer they judged.
    skippedSession++;
    continue;
  }
  const verdict = verdicts.get(item.objectId);
  if (!verdict) {
    skippedNoVerdict++;
    console.log(`  SKIP  ${item.objectId}: COMPLETED but no review-verdict score set`);
    continue;
  }
  const dataset = datasetForVerdict(verdict);
  if (!dataset) {
    skippedNotPromotable++;
    continue;
  }
  const io = await traceIo(item.objectId);
  if (!io) {
    skippedNoIo++;
    console.log(`  SKIP  ${item.objectId}: verdict ${verdict}, but no answer-delivered I/O readable`);
    continue;
  }
  if (dryRun) {
    console.log(`  DRY   ${item.objectId} → "${dataset}" (${verdict})`);
    promoted++;
    continue;
  }
  await ensureDataset(dataset);
  const res = await fetch(`${base}/api/public/dataset-items`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: datasetItemId(item.objectId), // upserts — re-promoting is not a dupe
      datasetName: dataset,
      input: io.input,
      expectedOutput: io.output,
      sourceTraceId: item.objectId,
      metadata: {
        verdict,
        knowledgeDigest: io.metadata["knowledge.version_digest"] ?? null,
        promotedAt: new Date().toISOString(),
      },
    }),
  });
  if (res.ok) {
    promoted++;
    console.log(`  PASS  ${item.objectId} → "${dataset}" (${verdict})`);
  } else {
    process.exitCode = 1;
    console.error(`  FAIL  ${item.objectId}: dataset-items ${res.status}`);
  }
}

console.log(
  `\n${dryRun ? "[dry-run] would promote" : "Promoted"} ${promoted} · no verdict ${skippedNoVerdict} · ` +
    `verdict says don't promote ${skippedNotPromotable} · session-precision ${skippedSession} · no I/O ${skippedNoIo}`,
);
if (skippedNoVerdict > 0) {
  console.log("→ items marked COMPLETED without a review-verdict score carry no decision; set one and re-run.");
}
