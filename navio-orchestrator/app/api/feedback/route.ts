// POST /api/feedback — one visitor's 👍/👎 on Navio's answer, written to
// Langfuse. Served by Next.js (not eve — eve only owns /eve/v1/*), same
// posture as app/api/contact/route.ts.
//
// The browser sends only what it legitimately knows: which session, which
// turn, and what the visitor thought. It never sees a Langfuse trace id and
// never holds a Langfuse credential — the server resolves the trace AND the
// orchestration context (which capability actually answered) from
// `feedbackRefs`, written by agent/hooks/langfuse.ts at turn end. There is no
// "surface" on the wire and no cross-service forwarding: this widget is ONE
// chat, so the vote always lands on the orchestrator's own trace, whether the
// FAQ subagent, the partner tool, or a direct reply produced the answer.
//
// Never returns an error the widget would surface. A feedback button that
// shows the visitor a failure is worse than one that silently misses a vote.
import {
  FeedbackRequestSchema,
  isReasonCode,
  submitFeedback,
  type FeedbackContext,
  type FeedbackRequest,
  type FeedbackTarget,
} from "@/lib/feedback";
import { feedbackRefs } from "@/lib/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Three upstream writes at most (score, reason/delete, queue push). */
export const maxDuration = 15;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Same allowlist convention as app/api/contact/route.ts — this file does not
 *  import that one's helpers (kept self-contained, matching this codebase's
 *  existing pattern of each public route owning its own small gate). */
function extraAllowedOrigins(): string[] {
  return (process.env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser / same-origin POSTs may omit Origin
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const reqHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host === reqHost) return true;
  const hostname = host.split(":")[0];
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) {
    return true;
  }
  return extraAllowedOrigins().includes(origin);
}

const MAX_REQUEST_BYTES = Number(process.env.NAVIO_MAX_REQUEST_BYTES ?? 16_000);

function tooLarge(req: Request): boolean {
  if (MAX_REQUEST_BYTES <= 0) return false;
  const len = req.headers.get("content-length");
  if (!len) return false;
  const bytes = Number(len);
  return Number.isFinite(bytes) && bytes > MAX_REQUEST_BYTES;
}

/** Per-instance, per-session throttle — a click, not a stream, so a handful
 *  per session is plenty. Soft guard; the real control is a Firewall rule. */
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
 * Resolve the score's target AND its orchestration context together — both
 * come from the SAME `feedbackRefs` lookup, so they can never disagree about
 * which turn they describe. Trace precision when the map still holds the
 * ref; SESSION precision otherwise (never dropped — see feedbackRefs' own
 * scope note in lib/langfuse.ts).
 */
function resolve(
  sessionId: string,
  turnId: string,
): { target: FeedbackTarget; context: FeedbackContext } {
  const ref = feedbackRefs.get(sessionId, turnId);
  if (ref) {
    return {
      target: { kind: "trace", traceId: ref.traceId },
      context: { route: ref.route, partnerSessionId: ref.partnerSessionId },
    };
  }
  return { target: { kind: "session", sessionId }, context: {} };
}

export async function POST(req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ detail: "Origin not allowed." }, 403);
  if (tooLarge(req)) return json({ detail: "Message too large." }, 413);

  let parsed: FeedbackRequest;
  try {
    parsed = FeedbackRequestSchema.parse(await req.json());
  } catch {
    return json({ detail: "Invalid feedback payload." }, 400);
  }

  if (rateLimited(parsed.sessionId)) {
    return json({ detail: "Too many feedback submissions." }, 429);
  }

  const { target, context } = resolve(parsed.sessionId, parsed.turnId);
  const result = await submitFeedback(
    {
      sessionId: parsed.sessionId,
      turnId: parsed.turnId,
      thumb: parsed.thumb,
      // An unknown reason code is dropped rather than stored: a CATEGORICAL
      // score with an off-taxonomy value would pollute the breakdown it
      // exists to produce.
      reason: isReasonCode(parsed.reason) ? parsed.reason : undefined,
      comment: parsed.comment ?? undefined,
    },
    target,
    context,
  );

  if (!result.ok) {
    console.error("FEEDBACK failed:", {
      detail: result.detail,
      thumb: parsed.thumb,
      target: target.kind,
      route: context.route ?? "unknown",
      commentChars: parsed.comment?.length ?? 0,
    });
    return json({ detail: "Feedback could not be recorded." }, 502);
  }

  return json({ ok: true, precision: result.target ?? "none" }, 200);
}
