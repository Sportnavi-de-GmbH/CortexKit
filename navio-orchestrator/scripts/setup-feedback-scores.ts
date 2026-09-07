// One-time (idempotent) setup: register the two feedback score CONFIGS and one
// Annotation Queue in the Langfuse project this service's credentials point at
// — for the ORCHESTRATOR (service 3, project "Navio — Multi-Agent").
//
// Third copy of this script (siblings: kb-agent-langsmith-starter's and the
// Partner agent's). Same logic, same live-verified traps — see those for the
// full rationale. The one thing unique here: `lib/feedback.ts`'s REASONS carry
// orchestrator-specific `correlate` hints (routing.decision_ms,
// partner.session_id, delegation.errors, …) instead of the simpler per-service
// ones, because a reviewer here is diagnosing a routing/delegation failure,
// not just a bad answer.
//
// ⚠ IDEMPOTENCY, THE HARD WAY. Score configs have NO update/delete endpoint —
// a duplicate create is PERMANENT. This script lists-then-creates, never
// create-then-catch-409 (Langfuse does not reject duplicate names).
//
// Run once for this project:
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

async function findExistingConfig(name: string): Promise<ExistingConfig | undefined> {
  const res = await fetch(`${configsBase}?limit=100`, { headers });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { data?: ExistingConfig[] };
  const matches = (json.data ?? []).filter((c) => c.name === name);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    console.warn(`WARN  ${matches.length} configs named "${name}" found — picking the earliest`);
    matches.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    console.warn(`      using ${matches[0].id} (created ${matches[0].createdAt ?? "unknown"})`);
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

// ⚠ REST field names differ from the Langfuse MCP tool's field names
// (`minValue`/`maxValue`/`categories` here vs `numericMinValue`/
// `numericMaxValue`/`categoricalCategories` on the MCP tool).

const feedbackConfigId = await ensure({
  name: FEEDBACK_SCORE,
  dataType: "NUMERIC",
  minValue: 0,
  maxValue: 1,
  description: "Visitor rating of one orchestrator answer. 1 = thumbs up, 0 = thumbs down.",
});

const reasonConfigId = await ensure({
  name: REASON_SCORE,
  dataType: "CATEGORICAL",
  categories: REASONS.map((r, i) => ({ label: r.code, value: i })),
  description: `Why a visitor rated an orchestrator answer negatively (thumbs down only). ${REASONS.map(
    (r) => `${r.code} = ${r.de}`,
  ).join(" · ")}`,
});

// ---------------------------------------------------------------------------
// The Annotation Queue — Langfuse's native review workflow.
// ---------------------------------------------------------------------------

const QUEUE_NAME = "Negative Feedback Review";
const QUEUE_DESCRIPTION =
  "Traces or sessions a visitor rated 👎 on the orchestrator. Filter status=PENDING, open " +
  "an item, read the trace (routing.selected, delegation.calls) and the user-feedback " +
  "score's comment + feedback-reason value, optionally leave a native Comment, then mark " +
  "the item COMPLETED.";

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

  // Try [] first (native status only, no new taxonomy); fall back to the
  // reason config only if the empty array is rejected — verified live in the
  // sibling projects that [] is in fact rejected (400).
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
      (usedFallback
        ? "  (scoreConfigIds:[] was rejected — attached feedback-reason instead)"
        : "  (scoreConfigIds:[] accepted)"),
  );
  return json.id;
}

const queueId = await ensureQueue(reasonConfigId);

console.log(`\nProject: ${langfuseBaseUrl()}`);
console.log("\nSet these in .env.local (or Vercel env, project navio-orchestrator):");
console.log(`LANGFUSE_FEEDBACK_SCORE_CONFIG_ID=${feedbackConfigId}`);
console.log(`LANGFUSE_REASON_SCORE_CONFIG_ID=${reasonConfigId}`);
console.log(`LANGFUSE_FEEDBACK_QUEUE_ID=${queueId}`);
