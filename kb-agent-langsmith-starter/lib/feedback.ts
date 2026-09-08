// USER FEEDBACK → Langfuse scores.
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
} from "./langfuse.ts";

// ---------------------------------------------------------------------------
// The taxonomy
//
// Chosen so that every subjective complaint has an OBJECTIVE counterpart
// already on the trace (see the mapping in `REASONS[].correlate`). That is what
// turns "users are unhappy" into "users are unhappy AND here is the metric that
// agrees with them" — and it is why these codes are not free text.
// ---------------------------------------------------------------------------

// The taxonomy lives in lib/feedback-taxonomy.ts (client-safe, shared with
// the widget component and the setup script) and is re-exported here so the
// existing imports keep working.
export { REASONS, isReasonCode, type ReasonCode } from "./feedback-taxonomy";
import { isReasonCode as isReason, type ReasonCode } from "./feedback-taxonomy";

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
export function feedbackScoreId(sessionId: string, turnId: string, suffix = ""): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `fb-${safe(sessionId)}-${safe(turnId)}${suffix}`;
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
  thumb: z.enum(["up", "down"]),
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
  /** Which Navio surface produced the answer — "faq" | "partner" | … */
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
    id: feedbackScoreId(input.sessionId, input.turnId),
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
    id: feedbackScoreId(input.sessionId, input.turnId, "-reason"),
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
    // Retry/double-click guard. Known accepted limitation: a SESSION-precision
    // vote (map already expired) can suppress a second, genuinely different
    // negative turn in the same session — matches the precision Langfuse
    // already accepted for that degraded path, not a new gap.
    if (queuedMarkers.has(key)) return;

    const res = await deps.fetchImpl(
      `${langfuseBaseUrl(deps.env)}/api/public/annotation-queues/${queueId}/items`,
      { method: "POST", headers: deps.headers, body: JSON.stringify({ objectId, objectType }) },
    );
    if (res.ok) queuedMarkers.set(key);
  } catch {
    // Observability must never break feedback submission.
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

    // A 👎 with or without a reason still deserves review, so this runs
    // before the reason branch below rather than depending on it.
    if (input.thumb === "down") {
      await pushToAnnotationQueue(target, annotationQueueId(env), { fetchImpl: doFetch, env, headers });
    } else if (score.comment !== "") {
      // A 👍 whose visitor took the time to write something is a candidate
      // golden example — route it to the positive review queue. Plain 👍 stays
      // statistics-only (the weekly report samples those).
      await pushToAnnotationQueue(target, positiveAnnotationQueueId(env), {
        fetchImpl: doFetch,
        env,
        headers,
      });
    }

    const reason = buildReasonPayload(input, target, env);
    if (reason) {
      await doFetch(base, { method: "POST", headers, body: JSON.stringify(reason) });
    } else {
      // RETRACTION. A visitor who flips 👎→👍 must not leave a dangling
      // "too_slow" behind — a categorical score has no "none" value, so the row
      // has to go. 404 here is success: there was nothing to retract.
      await doFetch(`${base}/${feedbackScoreId(input.sessionId, input.turnId, "-reason")}`, {
        method: "DELETE",
        headers,
      }).catch(() => undefined);
    }

    return { ok: true, target: target.kind };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
