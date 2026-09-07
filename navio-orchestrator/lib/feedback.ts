// USER FEEDBACK → Langfuse scores, for the NAVIO ORCHESTRATOR (service 3).
//
// One 👍/👎 per assistant answer, optionally with a reason and a written
// comment, written onto the SAME Langfuse trace that produced that answer —
// regardless of which capability (FAQ subagent, partner search, direct reply)
// actually did the work. The visitor only ever sees ONE assistant; feedback on
// its answer always lands on the orchestrator's own trace in "Navio —
// Multi-Agent", never forked off to another project.
//
// Third build of this module — siblings: kb-agent-langsmith-starter/lib/feedback.ts
// (FAQ) and SportnaviPartnerRecomandationBot/.../lib/feedback.ts (Partner). Same
// transport contract, same live-instance traps; two things differ here because
// this is a ROUTER, not a single-purpose answerer:
//
//   1. NO "surface" on the wire. The FAQ/Partner services literally render two
//      different chat screens, so the CLIENT knows and sends which one it is.
//      This widget is ONE chat — the visitor never knows or needs to know
//      whether the FAQ subagent, the partner tool, or a direct reply answered.
//      That information is resolved SERVER-SIDE from `feedbackRefs` (see
//      lib/langfuse.ts) and attached to the score as `route` — never trusted
//      from the client, which could not supply it accurately even if asked.
//   2. Optional partner cross-link. When `route === "find_partners"`, the
//      visitor's answer came from service 2, which traces its OWN search in
//      its OWN Langfuse project. This module records that session id in the
//      score's metadata so a reviewer can jump to the real retrieval detail —
//      it does NOT fork the score itself; the vote still belongs to the
//      trace the visitor actually looked at (the orchestrator's own).
//
// ── EVERY LIVE-INSTANCE DECISION BELOW WAS MEASURED (2026-08-18/19) ──────────
//   * `POST /api/public/scores` works. Ingestion is fine.
//   * READS: only `/api/public/v3/scores` works — v1 `/scores` and `/v2/scores`
//     both 404 here, exactly like the v1 traces endpoint.
//   * The read is a PROJECTION: without `fields=details`, `comment` and
//     `metadata` come back null even though they are stored.
//   * Re-POSTing the same `id` UPDATES in place — no duplicate — but the update
//     is a PARTIAL MERGE: an omitted field KEEPS its old value. Flipping to 👍
//     while omitting `comment` left the old negative comment attached to a
//     positive score. Hence `buildScorePayload` always sends every field.
//   * `DELETE /api/public/scores/{id}` (202) retracts a reason on flip, since a
//     categorical score has no "none" value.
//   * `POST /api/public/annotation-queues` REJECTS `scoreConfigIds: []` despite
//     the field only being marked "required," not "non-empty" — a queue must
//     be created with a real config attached.
//
// ── THE DISTINCTION THIS BUILD IS SPECIFICALLY REQUIRED TO PRESERVE ─────────
// A Langfuse Annotation Queue's "Annotate" sidebar is NOT a display of the
// scores this module writes. It is a SEPARATE manual-scoring tool: the moment
// a human reviewer selects a value in it, Langfuse writes a BRAND NEW score —
// same NAME (e.g. `feedback-reason`), Langfuse-generated id, `source:
// "ANNOTATION"` — that coexists with, and is NEVER read by, anything this
// module writes (`source: "API"`, deterministic `fb-{session}-{turn}` id).
// MEASURED LIVE 2026-08-19: a queue item whose visitor vote included a written
// reason still showed "Select category" (empty) in that sidebar, because
// nobody had clicked through it — the real vote was sitting, correctly, on the
// trace's own Scores tab the whole time. See FEEDBACK_SOURCE below: every
// consumer of "the visitor's feedback" — code or human — MUST filter on
// `source === "API"`. Reading by score NAME alone silently mixes a reviewer's
// own guess into what is supposed to be ground truth from the user.
//
// PRIVACY: sends the anonymous eve session id, the turn id, the thumb, a
// reason CODE, and — only if the visitor typed one — their comment. No IP, no
// user agent, no user id. Comment capped, disable with
// NAVIO_FEEDBACK_ALLOW_TEXT=false.
import { z } from "zod";

import {
  langfuseBaseUrl,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  queuedMarkers,
  type Route,
} from "./langfuse.ts";

// ---------------------------------------------------------------------------
// The taxonomy — identical codes to the FAQ/Partner services, so a reason is
// comparable across all three Navio agents rather than three incompatible
// vocabularies.
// ---------------------------------------------------------------------------

export const REASONS = [
  {
    code: "too_slow",
    de: "Zu langsam",
    correlate: "timing.duration_ms · routing.decision_ms",
  },
  {
    code: "not_relevant",
    de: "Nicht relevant",
    correlate: "routing.selected · retrieval.city",
  },
  {
    code: "incorrect",
    de: "Inhaltlich falsch",
    correlate: "knowledge.version_digest · partner.session_id",
  },
  { code: "unclear", de: "Unklar formuliert", correlate: "model · tokens.output" },
  {
    code: "unanswered",
    de: "Frage nicht beantwortet",
    correlate: "routing.selected = direct_reply | ask_question",
  },
  {
    code: "tool_failed",
    de: "Hat technisch nicht geklappt",
    correlate: "delegation.errors · partner.search_performed",
  },
  {
    code: "misunderstood",
    de: "Falsch verstanden",
    correlate: "routing.selected · delegation.calls",
  },
  { code: "other", de: "Sonstiges", correlate: "—" },
] as const;

export type ReasonCode = (typeof REASONS)[number]["code"];

const REASON_CODES = new Set<string>(REASONS.map((r) => r.code));

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && REASON_CODES.has(value);
}

// ---------------------------------------------------------------------------
// Score names + the source that makes this data trustworthy.
// ---------------------------------------------------------------------------

export const FEEDBACK_SCORE = "user-feedback";
export const REASON_SCORE = "feedback-reason";

/**
 * The one field that separates a REAL visitor vote from a REVIEWER's own
 * judgment left through Langfuse's Annotate sidebar. Every score this module
 * writes carries this constant, never a bare string literal — so "is this
 * genuine user feedback" is answerable by grepping for `FEEDBACK_SOURCE`
 * rather than by trusting a score's NAME, which a reviewer's annotation can
 * share. See the file header for what was measured live.
 */
export const FEEDBACK_SOURCE = "API" as const;

export const MAX_COMMENT_CHARS = 1_000;

export function allowFeedbackText(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NAVIO_FEEDBACK_ALLOW_TEXT !== "false";
}

// ---------------------------------------------------------------------------
// Score-config + annotation-queue linkage. Same posture as the sibling
// services: unset env var = the linkage is simply omitted, never a reason to
// block a visitor's vote.
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

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function feedbackScoreId(sessionId: string, turnId: string, suffix = ""): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `fb-${safe(sessionId)}-${safe(turnId)}${suffix}`;
}

/**
 * The wire contract for POST /api/feedback. Deliberately has NO `surface`
 * field — unlike the FAQ/Partner services' widgets, which render two literal
 * chat screens the client can name, this widget is ONE chat and the client
 * cannot know (and must not be trusted to say) which capability answered.
 *
 * `.nullish()` on reason/comment is LOAD-BEARING: the widget records a vote
 * the instant a thumb is clicked, sending `reason: null` before the reason
 * panel has even opened. `.optional()` accepts `undefined` but REJECTS
 * `null`, which 400s exactly the request that matters most (found in a real
 * browser on the FAQ service, 2026-08-18 — same trap applies here verbatim).
 */
export const FeedbackRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  thumb: z.enum(["up", "down"]),
  reason: z.string().max(64).nullish(),
  comment: z.string().max(MAX_COMMENT_CHARS * 4).nullish(),
});

export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export type Thumb = "up" | "down";

export interface FeedbackInput {
  sessionId: string;
  turnId: string;
  thumb: Thumb;
  reason?: ReasonCode;
  comment?: string;
}

/**
 * Orchestration context for one turn, resolved SERVER-SIDE from
 * `feedbackRefs` — never client-supplied. This is what lets a trace answer
 * "which capability actually produced this answer the visitor is rating"
 * without asking the browser, which does not reliably know.
 */
export interface FeedbackContext {
  route?: Route;
  partnerSessionId?: string;
}

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
  source: typeof FEEDBACK_SOURCE;
  metadata: Record<string, unknown>;
  traceId?: string;
  sessionId?: string;
  configId?: string;
}

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
 * here keeps whatever it held before — the same partial-merge trap documented
 * in every sibling of this module.
 */
export function buildScorePayload(
  input: FeedbackInput,
  target: FeedbackTarget,
  context: FeedbackContext,
  env: NodeJS.ProcessEnv = process.env,
): ScorePayload {
  const comment = input.thumb === "down" ? sanitizeComment(input.comment, env) : "";
  return {
    id: feedbackScoreId(input.sessionId, input.turnId),
    name: FEEDBACK_SCORE,
    value: input.thumb === "up" ? 1 : 0,
    dataType: "NUMERIC",
    comment,
    environment: langfuseEnvironment(env),
    source: FEEDBACK_SOURCE,
    metadata: {
      thumb: input.thumb,
      reason: input.thumb === "down" ? (input.reason ?? null) : null,
      turnId: input.turnId,
      route: context.route ?? null,
      ...(context.partnerSessionId ? { partnerSessionId: context.partnerSessionId } : {}),
    },
    ...(target.kind === "trace" ? { traceId: target.traceId } : { sessionId: target.sessionId }),
    ...(feedbackScoreConfigId(env) ? { configId: feedbackScoreConfigId(env) } : {}),
  };
}

/** The reason score. Only meaningful for 👎; a 👍 RETRACTS it (see submit). */
export function buildReasonPayload(
  input: FeedbackInput,
  target: FeedbackTarget,
  context: FeedbackContext,
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
    source: FEEDBACK_SOURCE,
    metadata: { turnId: input.turnId, route: context.route ?? null },
    ...(target.kind === "trace" ? { traceId: target.traceId } : { sessionId: target.sessionId }),
    ...(reasonScoreConfigId(env) ? { configId: reasonScoreConfigId(env) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Annotation Queue — Langfuse's native review workflow. Every 👎 pushes its
// trace (or session, if precision degraded) into the queue as a PENDING item.
// A 👎→👍 flip deliberately leaves an existing item alone — see the sibling
// modules' identical rationale.
// ---------------------------------------------------------------------------

async function pushToAnnotationQueue(
  target: FeedbackTarget,
  deps: { fetchImpl: FetchLike; env: NodeJS.ProcessEnv; headers: Record<string, string> },
): Promise<void> {
  try {
    const queueId = annotationQueueId(deps.env);
    if (!queueId) return;

    const objectType = target.kind === "trace" ? "TRACE" : "SESSION";
    const objectId = target.kind === "trace" ? target.traceId : target.sessionId;
    const key = `${objectType}:${objectId}`;
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
  target?: FeedbackTarget["kind"];
  detail?: string;
}

type FetchLike = typeof fetch;

/**
 * Write one visitor's feedback to Langfuse. NEVER throws: a failed score must
 * not turn into a visible error in the chat widget.
 */
export async function submitFeedback(
  input: FeedbackInput,
  target: FeedbackTarget,
  context: FeedbackContext = {},
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<SubmitResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;

  if (!langfuseEnabled(env)) {
    return { ok: true, detail: "langfuse-not-configured" };
  }

  const base = `${langfuseBaseUrl(env)}/api/public/scores`;
  const headers = { ...langfuseHeaders(env), "Content-Type": "application/json" };

  try {
    const score = buildScorePayload(input, target, context, env);
    const res = await doFetch(base, { method: "POST", headers, body: JSON.stringify(score) });
    if (!res.ok) {
      return { ok: false, detail: `score ${res.status}` };
    }

    if (input.thumb === "down") {
      await pushToAnnotationQueue(target, { fetchImpl: doFetch, env, headers });
    }

    const reason = buildReasonPayload(input, target, context, env);
    if (reason) {
      await doFetch(base, { method: "POST", headers, body: JSON.stringify(reason) });
    } else {
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
