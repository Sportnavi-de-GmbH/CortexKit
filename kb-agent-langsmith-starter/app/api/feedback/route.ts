// POST /api/feedback — one visitor's 👍/👎 on one answer, written to Langfuse.
//
// The browser sends only what it legitimately knows: which session, which turn,
// and what the visitor thought. It never sees a Langfuse trace id and never
// holds a Langfuse credential — the server resolves the trace and does the
// write. That is the whole reason this route exists rather than the widget
// calling Langfuse directly.
//
// Reuses the SAME public-endpoint gate as the partner proxy (size cap + origin
// allowlist): this is an unauthenticated, anonymous endpoint on a public
// widget, so it gets the same treatment as every other one.
//
// Never returns an error the widget would surface. A feedback button that
// shows the visitor a failure is worse than one that silently misses a vote.
import { checkPartnerRequest } from "@/lib/partner-proxy";
import {
  FeedbackRequestSchema,
  isReasonCode,
  resolveTraceViaLangfuse,
  retractFeedback,
  submitFeedback,
  type FeedbackRequest,
  type FeedbackTarget,
} from "@/lib/feedback";
import { feedbackRefs } from "@/lib/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Three upstream writes at most (score, reason, retraction). */
export const maxDuration = 15;


/** Per-instance, per-session throttle. Feedback is a click, not a stream — a
 *  handful per session is plenty, and this stops a loop hammering Langfuse.
 *  Like the contact form's limiter this is PER INSTANCE; the real control for a
 *  public deployment is a Firewall rule. */
const RATE_LIMIT = Number(process.env.FEEDBACK_RATE_LIMIT_PER_MIN ?? 30);
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  if (RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

/**
 * Resolve which Langfuse object the score should hang on.
 *
 * 1. The process-local map, when this instance answered the turn (dev, or a
 *    lucky warm instance).
 * 2. Otherwise ask Langfuse which trace answered this turn — on Vercel the
 *    invocation serving this route is almost never the one that ran the turn
 *    (measured 2026-09-08: 0 of 5), so this is the production path.
 * 3. SESSION precision as the last resort — deliberate, and NOT a silent
 *    downgrade to nothing: a vote cast seconds after the answer can beat
 *    ingestion, and losing it would be far worse than recording it one level
 *    up. The turn id travels in the score metadata, so feedback:reconcile can
 *    upgrade it later.
 */
async function resolveTarget(sessionId: string, turnId: string): Promise<FeedbackTarget> {
  const ref = feedbackRefs.get(sessionId, turnId);
  if (ref) return { kind: "trace", traceId: ref.traceId };
  const traceId = await resolveTraceViaLangfuse(sessionId, turnId);
  return traceId ? { kind: "trace", traceId } : { kind: "session", sessionId };
}

/**
 * Hand partner feedback to the service that owns the trace.
 *
 * The widget's two chat screens share one component but trace to two DIFFERENT
 * Langfuse projects. This service holds only the FAQ credentials, and — more
 * fundamentally — only the partner service holds the (session, turn) → trace
 * map for partner turns, because it created those traces. Scoring them from
 * here is not a permissions problem we could paper over with a second key
 * pair; we simply do not know which trace to score.
 *
 * So partner votes are forwarded verbatim. The ids travel unchanged: the widget
 * talks to the partner agent through this app's proxy, so the session and turn
 * it reports are already the partner service's own.
 */
async function forwardToPartner(body: unknown): Promise<Response> {
  const raw = process.env.PARTNER_AGENT_HOST?.trim();
  if (!raw) {
    // Same posture as the proxy: unconfigured partner host is a 503, not a crash.
    return Response.json({ detail: "Partner agent not configured." }, { status: 503 });
  }
  const host = (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = process.env.PARTNER_PROXY_SECRET?.trim();
  if (secret) headers["x-navio-proxy-secret"] = secret;

  try {
    const res = await fetch(`${host}/api/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("FEEDBACK forward failed:", { status: res.status });
      return Response.json({ detail: "Feedback could not be recorded." }, { status: 502 });
    }
    return Response.json(await res.json(), { status: 200 });
  } catch (err) {
    console.error("FEEDBACK forward failed:", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ detail: "Feedback could not be recorded." }, { status: 502 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const rejected = checkPartnerRequest(req);
  if (rejected) return rejected;

  let parsed: FeedbackRequest;
  try {
    parsed = FeedbackRequestSchema.parse(await req.json());
  } catch {
    return Response.json({ detail: "Invalid feedback payload." }, { status: 400 });
  }

  if (rateLimited(parsed.sessionId)) {
    return Response.json({ detail: "Too many feedback submissions." }, { status: 429 });
  }

  // Partner answers are traced by service 2, in its own Langfuse project, and
  // only it can resolve their trace ids — see forwardToPartner().
  if (parsed.surface === "partner") {
    return forwardToPartner(parsed);
  }

  const target = await resolveTarget(parsed.sessionId, parsed.turnId);
  const result =
    parsed.thumb === null
      ? // Retraction: delete the scores and the pending queue item — see retractFeedback.
        await retractFeedback(
          { sessionId: parsed.sessionId, turnId: parsed.turnId, epoch: parsed.epoch },
          target,
        )
      : await submitFeedback(
          {
            sessionId: parsed.sessionId,
            turnId: parsed.turnId,
            thumb: parsed.thumb,
            epoch: parsed.epoch,
            // An unknown reason code is dropped rather than stored: a CATEGORICAL
            // score with an off-taxonomy value would quietly pollute the very
            // breakdown this exists to produce.
            reason: isReasonCode(parsed.reason) ? parsed.reason : undefined,
            comment: parsed.comment ?? undefined,
            surface: parsed.surface ?? undefined,
          },
          target,
        );

  if (!result.ok) {
    // Shape only — never the visitor's words.
    console.error("FEEDBACK failed:", {
      detail: result.detail,
      thumb: parsed.thumb,
      target: target.kind,
      commentChars: parsed.comment?.length ?? 0,
    });
    return Response.json({ detail: "Feedback could not be recorded." }, { status: 502 });
  }
  // One shape-only line per vote, so the Vercel log tells the whole story of a
  // turn's feedback (vote → flip → retraction) without any visitor text.
  console.info("FEEDBACK ok:", {
    thumb: parsed.thumb,
    epoch: parsed.epoch ?? 0,
    precision: result.target ?? "none",
    commentChars: parsed.comment?.length ?? 0,
    surface: parsed.surface ?? "faq",
  });

  // `precision` lets the widget (and tests) tell trace-level from session-level
  // without exposing any id.
  return Response.json({ ok: true, precision: result.target ?? "none" }, { status: 200 });
}
