// USER FEEDBACK → Langfuse scores, for the PARTNER AGENT (service 2).
//
// Sibling of kb-agent-langsmith-starter/lib/feedback.ts. Copied rather than
// shared for the same reason lib/langfuse.ts is: these are separate
// deployments with separate credentials, and the whole point is that this one
// writes into "Navio — Partner" while that one writes into "Navio — FAQ".
//
// WHY THIS EXISTS HERE AT ALL: the widget's Partner screen is served by the
// widget (service 1), but the TRACE that answered it was produced HERE, and
// only this process holds the (session, turn) → trace map. Service 1 therefore
// forwards partner feedback to this service instead of trying to score a trace
// it has never seen.
//
// One 👍/👎 per assistant answer, optionally with a reason and a written
// comment, written onto the SAME Langfuse trace that produced that answer.
//
// ── EVERY DECISION BELOW WAS MEASURED AGAINST THE LIVE INSTANCE (2026-08-18) ──
// The Langfuse docs describe several plausible designs; these are the ones that
// actually work on a v4 instance running in `events_only` mode:
//
//   * `POST /api/public/scores` works. Ingestion is fine.
//   * READS: only `/api/public/v3/scores` works — v1 `/scores` and `/v2/scores`
//     both return 404 here, exactly like the v1 traces endpoint. Do not "fix"
//     a read back to /scores.
//   * The read is a PROJECTION: without `fields=details`, `comment` and
//     `metadata` come back null even though they are stored. An unrequested
//     field is indistinguishable from an empty one.
//   * Re-POSTing with the same `id` UPDATES in place — no duplicate. That is
//     what makes a 👎→👍 flip, and a retry, safe.
//   * …but the update is a PARTIAL MERGE: an omitted field KEEPS its old
//     value. Measured: flipping to positive while omitting `comment` left the
//     old negative comment attached to a now-positive score. Sending
//     `comment: ""` clears it. Hence `buildScorePayload` always sends every
//     field explicitly. Never make a field conditional here.
//   * `DELETE /api/public/scores/{id}` works (202) — used to retract a reason.
//
// PRIVACY: this module sends the anonymous eve session id, the turn id, the
// thumb, a reason CODE, and — only if the visitor typed one — their comment.
// No IP, no user agent, no user id. The comment is capped and can be disabled
// with NAVIO_FEEDBACK_ALLOW_TEXT=false.
import { z } from "zod";

import {
  langfuseBaseUrl,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  queuedMarkers,
} from "./langfuse";

// ---------------------------------------------------------------------------
// The taxonomy
//
// Chosen so that every subjective complaint has an OBJECTIVE counterpart
// already on the trace (see the mapping in `REASONS[].correlate`). That is what
// turns "users are unhappy" into "users are unhappy AND here is the metric that
// agrees with them" — and it is why these codes are not free text.
// ---------------------------------------------------------------------------

// The taxonomy lives in lib/feedback-taxonomy.ts (client-safe, shared with
// the widget build) and is re-exported here so existing imports keep working.
export { REASONS, isReasonCode, type ReasonCode } from "./feedback-taxonomy";
import { isReasonCode as isReason, type ReasonCode } from "./feedback-taxonomy";
import { traceForTurn } from "./feedback-insights";

// ---------------------------------------------------------------------------
// Score names
//
// TWO scores rather than one with metadata, deliberately. Langfuse's metrics
// API groups by score NAME and VALUE (`scores-numeric` / `scores-categorical`
// views); metadata is not a group-by dimension. A reason buried in metadata
// cannot be charted, which would defeat the point.
// ---------------------------------------------------------------------------

/** NUMERIC 1 = 👍, 0 = 👎. Numeric (not boolean/categorical) because its
 *  AVERAGE is the satisfaction rate, straight out of the metrics API. */
export const FEEDBACK_SCORE = "user-feedback";

/** CATEGORICAL — only present on 👎, so "count by value" is the reason
 *  breakdown with no filtering gymnastics. */
export const REASON_SCORE = "feedback-reason";

/** Max characters of visitor-written text. Volunteered, but still capped. */
export const MAX_COMMENT_CHARS = 1_000;

/** Free text is opt-OUT rather than opt-in: it is the single most useful signal
 *  and it is volunteered, unlike the conversation text that
 *  LANGFUSE_RECORD_IO gates. Set NAVIO_FEEDBACK_ALLOW_TEXT=false to disable. */
export function allowFeedbackText(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NAVIO_FEEDBACK_ALLOW_TEXT !== "false";
}

// ---------------------------------------------------------------------------
// Score-config + annotation-queue linkage.
//
// All three ids come from `scripts/setup-feedback-scores.ts`, which is the
// only thing allowed to create them (score configs have no update/delete
// endpoint — see that script's header). Unset = the corresponding linkage is
// simply omitted; feedback still writes and the queue simply doesn't receive
// items. Same "unconfigured = silent no-op" posture as the rest of this
// integration, never a reason to block a visitor's vote.
// ---------------------------------------------------------------------------

export function feedbackScoreConfigId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANGFUSE_FEEDBACK_SCORE_CONFIG_ID?.trim() || undefined;
}

export function reasonScoreConfigId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANGFUSE_REASON_SCORE_CONFIG_ID?.trim() || undefined;
}

export function annotationQueueId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANGFUSE_FEEDBACK_QUEUE_ID?.trim() || undefined;
}

/** The "Feedback — Positive Examples" queue. Unset => positives are counted
 *  in the stats but never queued — same silent-no-op contract as everything
 *  else here. */
export function positiveAnnotationQueueId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Deterministic score id — THE mechanism for "update instead of duplicate".
 *  Derived from the turn, so the same answer can only ever hold one verdict,
 *  and a double-click or a retry is a no-op rather than a second row. */
export function feedbackScoreId(
  sessionId: string,
  turnId: string,
  suffix = "",
  epoch = 0,
): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  // `epoch` counts RETRACTIONS on this turn. Langfuse applies a score DELETE
  // asynchronously — measured 2026-09-09: ~2 minutes — and a later POST with
  // the SAME id is wiped when that delete finally lands. So a re-vote after a
  // retraction must use a fresh id; the widget bumps the epoch on every
  // retraction. Epoch 0 keeps the historical id shape.
  return `fb-${safe(sessionId)}-${safe(turnId)}${epoch > 0 ? `-e${epoch}` : ""}${suffix}`;
}

/**
 * The wire contract for POST /api/feedback.
 *
 * Lives here rather than in the route so it can be unit-tested — it is domain
 * validation, not routing.
 *
 * `.nullish()` on reason/comment is LOAD-BEARING, not laziness. The widget
 * records a vote the moment a thumb is clicked and sends `reason: null`,
 * because it has not asked why yet. Zod's `.optional()` accepts `undefined` but
 * REJECTS `null`, so an optional-only schema 400s exactly the request that
 * matters most: the visitor who votes and never opens the reason panel. Found
 * in a real browser; hand-written curl payloads never contain those nulls.
 */
export const FeedbackRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  /** `null` = the visitor RETRACTED their vote (second click on the same
   *  thumb). It is a real event that must reach Langfuse, not a local undo:
   *  the scores are deleted and the review-queue item removed. */
  thumb: z.enum(["up", "down"]).nullable(),
  /** Retraction counter for this turn (see feedbackScoreId). Missing = 0. */
  epoch: z.number().int().min(0).max(10_000).optional(),
  reason: z.string().max(64).nullish(),
  comment: z.string().max(MAX_COMMENT_CHARS * 4).nullish(),
  surface: z.enum(["faq", "partner"]).nullish(),
});

export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export type Thumb = "up" | "down";

export interface FeedbackInput {
  sessionId: string;
  turnId: string;
  thumb: Thumb;
  reason?: ReasonCode;
  comment?: string;
  /** Retraction counter for this turn — selects the score id (see feedbackScoreId). */
  epoch?: number;
  /** Always "partner" here; kept for parity with the FAQ module. */
  surface?: string;
}

/** Where the feedback should land. A trace is preferred; a session is the
 *  fallback so feedback is never silently dropped when the map has expired. */
export type FeedbackTarget =
  | { kind: "trace"; traceId: string }
  | { kind: "session"; sessionId: string };

export interface ScorePayload {
  id: string;
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "CATEGORICAL";
  comment: string;
  environment: string;
  source: "API";
  metadata: Record<string, unknown>;
  traceId?: string;
  sessionId?: string;
  /** Links this score to its declared config so Langfuse enforces/aggregates
   *  it as a proper dimension rather than a loose value. Omitted, not null,
   *  when unconfigured — see feedbackScoreConfigId/reasonScoreConfigId. */
  configId?: string;
}

/** Trim, collapse and cap visitor text. Returns "" when text is not allowed —
 *  and "" is meaningful: it CLEARS a previous comment (see the header note on
 *  partial merges), which is exactly what a 👎→👍 flip must do. */
export function sanitizeComment(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!allowFeedbackText(env)) return "";
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_COMMENT_CHARS);
}

/**
 * Build the main 👍/👎 score.
 *
 * EVERY FIELD IS ALWAYS SENT. The API merges on update, so a field omitted
 * here keeps whatever it held before — which is how a positive score ends up
 * still carrying the complaint the visitor wrote when they had voted negative.
 */
export function buildScorePayload(
  input: FeedbackInput,
  target: FeedbackTarget,
  env: NodeJS.ProcessEnv = process.env,
): ScorePayload {
  // BOTH thumbs keep their comment now: a 👍 with a comment is the entry
  // ticket to the "Feedback — Positive Examples" review queue, so dropping
  // it here would silently kill the golden-answers pipeline.
  const comment = sanitizeComment(input.comment, env);
  return {
    id: feedbackScoreId(input.sessionId, input.turnId, "", input.epoch),
    name: FEEDBACK_SCORE,
    value: input.thumb === "up" ? 1 : 0,
    dataType: "NUMERIC",
    comment,
    environment: langfuseEnvironment(env),
    source: "API",
    metadata: {
      thumb: input.thumb,
      // Mirrored from the reason score purely as redundancy — the score is
      // what gets charted.
      reason: input.thumb === "down" ? (input.reason ?? null) : null,
      surface: input.surface ?? "unknown",
      turnId: input.turnId,
    },
    ...(target.kind === "trace" ? { traceId: target.traceId } : { sessionId: target.sessionId }),
    ...(feedbackScoreConfigId(env) ? { configId: feedbackScoreConfigId(env) } : {}),
  };
}

/** The reason score. Only meaningful for 👎; a 👍 RETRACTS it (see submit). */
export function buildReasonPayload(
  input: FeedbackInput,
  target: FeedbackTarget,
  env: NodeJS.ProcessEnv = process.env,
): ScorePayload | undefined {
  if (input.thumb !== "down" || !input.reason) return undefined;
  return {
    id: feedbackScoreId(input.sessionId, input.turnId, "-reason", input.epoch),
    name: REASON_SCORE,
    value: input.reason,
    dataType: "CATEGORICAL",
    comment: "",
    environment: langfuseEnvironment(env),
    source: "API",
    metadata: { surface: input.surface ?? "unknown", turnId: input.turnId },
    ...(target.kind === "trace" ? { traceId: target.traceId } : { sessionId: target.sessionId }),
    ...(reasonScoreConfigId(env) ? { configId: reasonScoreConfigId(env) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Annotation Queue — Langfuse's native review workflow.
//
// Every 👎 pushes its trace (or session, if precision has degraded) into the
// queue as a PENDING item, so a team member has a native to-do list — filter
// PENDING in the Langfuse UI, read the trace + this score's comment + the
// reason score, optionally leave a native Comment, mark COMPLETED.
//
// Deliberately does NOT touch an existing item on a 👎→👍 flip. Deleting or
// auto-completing it would need a persisted queueItemId just to find it again,
// for marginal benefit — and "flagged, then the visitor reconsidered" is
// itself a useful signal a reviewer should see, not noise to erase.
// ---------------------------------------------------------------------------

type QueueDeps = { fetchImpl: FetchLike; env: NodeJS.ProcessEnv; headers: Record<string, string> };

interface QueueItemLite {
  id: string;
  objectId?: string;
  objectType?: string;
  status?: string;
}

/** The queue's items for one object. Langfuse itself does not dedupe queue
 *  items, and the local marker is per-instance — measured on Vercel
 *  2026-09-08: five identical POSTs produced two items. So the queue is asked
 *  directly; one small read per queued vote. Any failure reads as "nothing
 *  there", which errs on the side of a reviewable duplicate over a lost vote. */
async function queueItemsFor(
  queueId: string,
  objectType: string,
  objectId: string,
  deps: QueueDeps,
): Promise<QueueItemLite[]> {
  try {
    const res = await deps.fetchImpl(
      `${langfuseBaseUrl(deps.env)}/api/public/annotation-queues/${queueId}/items?limit=100`,
      { headers: deps.headers },
    );
    if (!res.ok) return [];
    const items = ((await res.json()) as { data?: QueueItemLite[] }).data ?? [];
    return items.filter((i) => i.objectId === objectId && i.objectType === objectType);
  } catch {
    return [];
  }
}

async function alreadyQueued(
  queueId: string,
  objectType: string,
  objectId: string,
  deps: QueueDeps,
): Promise<boolean> {
  return (await queueItemsFor(queueId, objectType, objectId, deps)).length > 0;
}

/** The queue objects a vote may be filed under: its trace when known, and
 *  ALWAYS its session — a vote that landed at session precision (ingestion
 *  not caught up) was queued as a SESSION item, and a later retraction or
 *  flip resolving to the trace must still find it. */
function queueObjectsFor(
  target: FeedbackTarget,
  sessionId: string,
): Array<{ objectType: "TRACE" | "SESSION"; objectId: string }> {
  const objects: Array<{ objectType: "TRACE" | "SESSION"; objectId: string }> = [];
  if (target.kind === "trace") objects.push({ objectType: "TRACE", objectId: target.traceId });
  objects.push({ objectType: "SESSION", objectId: sessionId });
  return objects;
}

/** Remove this vote's PENDING item(s) from a queue. COMPLETED items stay —
 *  a review that already happened is a fact, not something a visitor's later
 *  click can un-happen. Never throws. */
async function removeFromQueue(
  target: FeedbackTarget,
  sessionId: string,
  queueId: string | undefined,
  deps: QueueDeps,
): Promise<void> {
  if (!queueId) return;
  try {
    for (const { objectType, objectId } of queueObjectsFor(target, sessionId)) {
      const pending = (await queueItemsFor(queueId, objectType, objectId, deps)).filter(
        (i) => i.status === "PENDING",
      );
      for (const item of pending) {
        const res = await deps.fetchImpl(
          `${langfuseBaseUrl(deps.env)}/api/public/annotation-queues/${queueId}/items/${item.id}`,
          { method: "DELETE", headers: deps.headers },
        );
        if (!res.ok) console.warn("FEEDBACK queue item delete failed:", { queueId, objectType, status: res.status });
      }
      queuedMarkers.delete(`${queueId}:${objectType}:${objectId}`);
    }
  } catch (err) {
    // Observability must never break feedback submission.
    console.warn("FEEDBACK queue removal threw:", { queueId, detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Never throws. Silent no-op when the queue isn't configured (same posture
 *  as the rest of this module) or when this target was already queued. */
async function pushToAnnotationQueue(
  target: FeedbackTarget,
  queueId: string | undefined,
  deps: { fetchImpl: FetchLike; env: NodeJS.ProcessEnv; headers: Record<string, string> },
): Promise<void> {
  try {
    if (!queueId) return;

    const objectType = target.kind === "trace" ? "TRACE" : "SESSION";
    const objectId = target.kind === "trace" ? target.traceId : target.sessionId;
    const key = `${queueId}:${objectType}:${objectId}`;
    // Fast path only — the marker is per-instance, so the queue itself is the
    // authority on what is already there.
    if (queuedMarkers.has(key)) return;
    if (await alreadyQueued(queueId, objectType, objectId, deps)) {
      queuedMarkers.set(key);
      return;
    }

    const res = await deps.fetchImpl(
      `${langfuseBaseUrl(deps.env)}/api/public/annotation-queues/${queueId}/items`,
      { method: "POST", headers: deps.headers, body: JSON.stringify({ objectId, objectType }) },
    );
    if (res.ok) queuedMarkers.set(key);
    // Shape only, never visitor text — but VISIBLE: a silently swallowed
    // queue failure is indistinguishable from "nobody voted" in the logs.
    else console.warn("FEEDBACK queue push failed:", { queueId, objectType, status: res.status });
  } catch (err) {
    // Observability must never break feedback submission.
    console.warn("FEEDBACK queue push threw:", { queueId, detail: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface SubmitResult {
  ok: boolean;
  /** "trace" | "session" — which precision the feedback actually achieved. */
  target?: FeedbackTarget["kind"];
  detail?: string;
}

type FetchLike = typeof fetch;

/**
 * Resolve the trace that answered (session, turn) by asking LANGFUSE, for when
 * the process-local `feedbackRefs` map has nothing — which on Vercel is the
 * normal case, not the exception (measured 2026-09-08 on the widget: 0 of 5
 * votes found the map, because the invocation serving /api/feedback is rarely
 * the one that finished the turn). One read of the session's observations; the
 * turn ordinal picks the trace (see traceForTurn). Never throws; undefined
 * means "not resolvable yet" — a vote cast seconds after the answer can beat
 * ingestion, and feedback:reconcile upgrades those later.
 */
export async function resolveTraceViaLangfuse(
  sessionId: string,
  turnId: string,
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  if (!langfuseEnabled(env)) return undefined;
  try {
    const qs = new URLSearchParams({ sessionId, fields: "core,basic,time", limit: "100" });
    const res = await doFetch(`${langfuseBaseUrl(env)}/api/public/v2/observations?${qs}`, {
      headers: langfuseHeaders(env),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return undefined;
    const data =
      ((await res.json()) as { data?: Array<{ traceId?: string; startTime?: string }> }).data ?? [];
    return traceForTurn(data, turnId);
  } catch {
    return undefined;
  }
}

/**
 * Write one visitor's feedback to Langfuse. NEVER throws: a failed score must
 * not turn into a visible error in a chat widget.
 */
export async function submitFeedback(
  input: FeedbackInput,
  target: FeedbackTarget,
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<SubmitResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;

  if (!langfuseEnabled(env)) {
    // Same contract as the rest of the Langfuse integration: no credentials is
    // a silent no-op, never an error.
    return { ok: true, detail: "langfuse-not-configured" };
  }

  const base = `${langfuseBaseUrl(env)}/api/public/scores`;
  const headers = { ...langfuseHeaders(env), "Content-Type": "application/json" };

  try {
    const score = buildScorePayload(input, target, env);
    const res = await doFetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(score),
    });
    if (!res.ok) {
      return { ok: false, detail: `score ${res.status}` };
    }

    // THE QUEUES MIRROR THE CURRENT VOTE. A 👎 is a pending item in the
    // negative queue and nothing in the positive one; a 👍 with a comment the
    // reverse; a plain 👍 is in neither. So a flip MOVES the item — the
    // earlier "leave the item on a flip" rule left reviewers opening 👎 items
    // whose visitor had since said 👍, which is exactly the stale state the
    // owner asked to eliminate. COMPLETED items are never touched.
    const qdeps: QueueDeps = { fetchImpl: doFetch, env, headers };
    if (input.thumb === "down") {
      await pushToAnnotationQueue(target, annotationQueueId(env), qdeps);
      await removeFromQueue(target, input.sessionId, positiveAnnotationQueueId(env), qdeps);
    } else {
      await removeFromQueue(target, input.sessionId, annotationQueueId(env), qdeps);
      if (score.comment !== "") {
        // A 👍 whose visitor took the time to write something is a candidate
        // golden example. Plain 👍 stays statistics-only (the weekly report
        // samples those).
        await pushToAnnotationQueue(target, positiveAnnotationQueueId(env), qdeps);
      } else {
        await removeFromQueue(target, input.sessionId, positiveAnnotationQueueId(env), qdeps);
      }
    }

    const reason = buildReasonPayload(input, target, env);
    if (reason) {
      await doFetch(base, { method: "POST", headers, body: JSON.stringify(reason) });
    } else {
      // RETRACTION. A visitor who flips 👎→👍 must not leave a dangling
      // "too_slow" behind — a categorical score has no "none" value, so the row
      // has to go. 404 here is success: there was nothing to retract.
      await doFetch(`${base}/${feedbackScoreId(input.sessionId, input.turnId, "-reason", input.epoch)}`, {
        method: "DELETE",
        headers,
      }).catch(() => undefined);
    }

    return { ok: true, target: target.kind };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The visitor withdrew their vote (second click on the same thumb). Langfuse
 * must forget it completely: both scores are DELETED (the ids are
 * deterministic, so this needs no lookup and no local state — a vote that was
 * later reconciled from session to trace precision still has the same id),
 * and the vote's PENDING review-queue items are removed. A 404 on either score
 * is success: there was nothing to forget. NEVER throws.
 */
export async function retractFeedback(
  input: { sessionId: string; turnId: string; epoch?: number },
  target: FeedbackTarget,
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<SubmitResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  if (!langfuseEnabled(env)) return { ok: true, detail: "langfuse-not-configured" };

  const base = `${langfuseBaseUrl(env)}/api/public/scores`;
  const headers = { ...langfuseHeaders(env), "Content-Type": "application/json" };
  try {
    for (const suffix of ["", "-reason"]) {
      const res = await doFetch(`${base}/${feedbackScoreId(input.sessionId, input.turnId, suffix, input.epoch)}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok && res.status !== 404) return { ok: false, detail: `delete ${res.status}` };
    }
    const qdeps: QueueDeps = { fetchImpl: doFetch, env, headers };
    await removeFromQueue(target, input.sessionId, annotationQueueId(env), qdeps);
    await removeFromQueue(target, input.sessionId, positiveAnnotationQueueId(env), qdeps);
    return { ok: true, target: target.kind };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
