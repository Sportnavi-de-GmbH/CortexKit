// One-time (idempotent) setup: register the two feedback score CONFIGS and one
// Annotation Queue in the Langfuse project this service's credentials point at.
//
// WHY CONFIGS AND NOT JUST SCORES: a score written without a config still
// arrives, but it is a loose value. A config makes it a declared dimension —
// Langfuse then knows `user-feedback` is numeric 0..1 and that
// `feedback-reason` has exactly these eight categories, which is what turns the
// dashboard filters and the `scores-categorical` metrics view into something
// you can actually chart. Registering them up front also stops a typo in a
// reason code from quietly inventing a ninth category.
//
// WHY AN ANNOTATION QUEUE: Langfuse's native review workflow. Every 👎
// (agent/../lib/feedback.ts's `pushToAnnotationQueue`) pushes the trace into
// this queue as a PENDING item, so a team member has a native to-do list of
// negative feedback — filter PENDING, read the trace, mark COMPLETED — with
// zero custom UI.
//
// ⚠ IDEMPOTENCY, THE HARD WAY. The first version of this script relied on the
// create call returning a conflict/409 for "already exists." Langfuse does NOT
// reject a duplicate name — it just creates another config with the same name.
// That produced 3× `user-feedback` and 2× `feedback-reason` duplicate configs in
// the FAQ project before this was caught. Score configs have NO update/delete
// endpoint (verified against the instance's own OpenAPI spec — only GET
// exists), so a bad create is PERMANENT clutter. This version therefore lists
// first and only creates when genuinely absent — list-then-create, never
// create-then-catch.
//
// Run once per project (FAQ, Partner, …) — each has its own credentials:
//   npx tsx scripts/setup-feedback-scores.ts
import "../lib/load-env.ts";

import { FEEDBACK_SCORE, REASON_SCORE, REASONS } from "../lib/feedback.ts";
import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse.ts";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to set up.");
  process.exit(3);
}

const headers = { ...langfuseHeaders(), "Content-Type": "application/json" };
const configsBase = `${langfuseBaseUrl()}/api/public/score-configs`;
const queuesBase = `${langfuseBaseUrl()}/api/public/annotation-queues`;

interface ExistingConfig {
  id: string;
  name: string;
  createdAt?: string;
}

/** GET-first. Filters by exact name, and if duplicates already exist (the
 *  historical mess this file caused), deterministically picks the earliest —
 *  the one Langfuse has effectively been treating as canonical the longest. */
async function findExistingConfig(name: string): Promise<ExistingConfig | undefined> {
  const res = await fetch(`${configsBase}?limit=100`, { headers });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { data?: ExistingConfig[] };
  const matches = (json.data ?? []).filter((c) => c.name === name);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    console.warn(`WARN  ${matches.length} configs named "${name}" found — picking the earliest`);
    matches.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    console.warn(
      `      using ${matches[0].id} (created ${matches[0].createdAt ?? "unknown"})`,
    );
    console.warn(
      `      extra duplicate(s), harmless clutter, CANNOT be deleted via the API: ${matches
        .slice(1)
        .map((m) => m.id)
        .join(", ")}`,
    );
  }
  return matches[0];
}

async function ensure(body: Record<string, unknown>): Promise<string> {
  const name = body.name as string;
  const existing = await findExistingConfig(name);
  if (existing) {
    console.log(`PASS  exists   ${name}  configId=${existing.id}`);
    return existing.id;
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

// ⚠ THE REST FIELD NAMES ARE NOT THE MCP TOOL'S FIELD NAMES.
// The Langfuse MCP tool takes `numericMinValue` / `numericMaxValue` /
// `categoricalCategories`; the REST API this script uses takes `minValue` /
// `maxValue` / `categories`. Sending the MCP spelling here fails with a bare
// "expected array, received undefined" that names no field. Verified against
// the instance's own OpenAPI (CreateScoreConfigRequest / ConfigCategory).

// The thumb. NUMERIC rather than BOOLEAN/CATEGORICAL because its AVERAGE is the
// satisfaction rate, straight out of the metrics API's scores-numeric view.
const feedbackConfigId = await ensure({
  name: FEEDBACK_SCORE,
  dataType: "NUMERIC",
  minValue: 0,
  maxValue: 1,
  description: "Visitor rating of one answer. 1 = thumbs up, 0 = thumbs down.",
});

// The reason. CATEGORICAL so "count by value" IS the breakdown.
//
// LABELS ARE THE MACHINE CODES, not the German UI text. A categorical score is
// written with its LABEL as the value, so the labels here must be exactly what
// `lib/feedback.ts` sends — and keeping them language-independent means the
// dashboard does not become German-only the day a second locale appears. The
// human wording lives in the description and in the widget.
const reasonConfigId = await ensure({
  name: REASON_SCORE,
  dataType: "CATEGORICAL",
  categories: REASONS.map((r, i) => ({ label: r.code, value: i })),
  description: `Why a visitor rated an answer negatively (thumbs down only). ${REASONS.map(
    (r) => `${r.code} = ${r.de}`,
  ).join(" · ")}`,
});

// ---------------------------------------------------------------------------
// The Annotation Queue — Langfuse's native review workflow.
// ---------------------------------------------------------------------------

const QUEUE_NAME = "Negative Feedback Review";
const QUEUE_DESCRIPTION =
  "Traces or sessions a visitor rated 👎. Filter status=PENDING, open an item, " +
  "read the trace and the user-feedback score's comment + feedback-reason " +
  "value, optionally leave a native Comment, then mark the item COMPLETED.";

interface ExistingQueue {
  id: string;
  name: string;
}

async function findExistingQueue(name: string): Promise<ExistingQueue | undefined> {
  const res = await fetch(`${queuesBase}?limit=100`, { headers });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { data?: ExistingQueue[] };
  return (json.data ?? []).find((q) => q.name === name);
}

async function createQueue(scoreConfigIds: string[]): Promise<Response> {
  return fetch(queuesBase, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: QUEUE_NAME, description: QUEUE_DESCRIPTION, scoreConfigIds }),
  });
}

async function ensureQueue(reasonId: string): Promise<string> {
  const existing = await findExistingQueue(QUEUE_NAME);
  if (existing) {
    console.log(`PASS  exists   queue "${QUEUE_NAME}"  queueId=${existing.id}`);
    return existing.id;
  }

  // The OpenAPI spec marks `scoreConfigIds` required, but "required" may just
  // mean "field present," not "non-empty." Try [] first — the minimal choice,
  // since the decision here is native status only, no new taxonomy. Fall back
  // to attaching the reason config (lets a reviewer see/confirm the visitor's
  // stated reason while annotating) only if the empty array is rejected.
  let res = await createQueue([]);
  let usedFallback = false;
  if (!res.ok && reasonId) {
    usedFallback = true;
    res = await createQueue([reasonId]);
  }

  const json = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !json.id) {
    console.error(`FAIL  queue "${QUEUE_NAME}": ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    process.exitCode = 1;
    return "";
  }
  console.log(
    `PASS  created  queue "${QUEUE_NAME}"  queueId=${json.id}` +
      (usedFallback ? "  (scoreConfigIds:[] was rejected — attached feedback-reason instead)" : "  (scoreConfigIds:[] accepted)"),
  );
  return json.id;
}

const queueId = await ensureQueue(reasonConfigId);

console.log(`\nProject: ${langfuseBaseUrl()}`);
console.log("Re-run this for every project that receives feedback (FAQ, Partner, …).");
console.log("\nSet these in .env.local (or Vercel env):");
console.log(`LANGFUSE_FEEDBACK_SCORE_CONFIG_ID=${feedbackConfigId}`);
console.log(`LANGFUSE_REASON_SCORE_CONFIG_ID=${reasonConfigId}`);
console.log(`LANGFUSE_FEEDBACK_QUEUE_ID=${queueId}`);
