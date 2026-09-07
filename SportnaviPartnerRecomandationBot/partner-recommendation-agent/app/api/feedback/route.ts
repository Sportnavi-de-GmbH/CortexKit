// POST /api/feedback — the Partner Agent's own feedback endpoint.
//
// WHY THIS EXISTS RATHER THAN THE WIDGET WRITING THE SCORE ITSELF:
// the visitor rates the answer on the widget's Partner screen (service 1), but
// the TRACE that produced it was created HERE, and only this process holds the
// (session, turn) → trace map. Service 1 cannot score a trace it has never
// seen, and it does not hold this project's Langfuse credentials — so it
// forwards the vote and this service records it against "Navio — Partner".
//
// THREAT MODEL — different from service 1's endpoint. This is an INTERNAL
// service-to-service route, never called by a browser, so it does not get the
// public origin gate: it requires the shared secret when one is configured and
// otherwise accepts loopback only. Fail closed in production; stay usable in
// local dev where no secret is set.
import {
  FeedbackRequestSchema,
  isReasonCode,
  submitFeedback,
  type FeedbackRequest,
  type FeedbackTarget,
} from "../../../lib/feedback";
import { feedbackRefs } from "../../../lib/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Same header the proxy/partner-client already uses for service-to-service
 *  auth, so there is one secret to manage rather than two. */
const SECRET_HEADER = "x-navio-proxy-secret";

function isLoopback(req: Request): boolean {
  try {
    const host = new URL(req.url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Fail CLOSED when a secret is configured, OPEN only on loopback. A public
 *  deployment must set PARTNER_PROXY_SECRET; without it this route would
 *  otherwise be an open write endpoint into the Langfuse project. */
function authorized(req: Request): boolean {
  const secret = process.env.PARTNER_PROXY_SECRET?.trim();
  if (secret) return req.headers.get(SECRET_HEADER) === secret;
  return isLoopback(req);
}

function resolveTarget(sessionId: string, turnId: string): FeedbackTarget {
  const ref = feedbackRefs.get(sessionId, turnId);
  // Session-level rather than nothing when the map has expired — see the note
  // on feedbackRefs in lib/langfuse.ts.
  return ref ? { kind: "trace", traceId: ref.traceId } : { kind: "session", sessionId };
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json({ detail: "Not authorized." }, { status: 401 });
  }

  let parsed: FeedbackRequest;
  try {
    parsed = FeedbackRequestSchema.parse(await req.json());
  } catch {
    return Response.json({ detail: "Invalid feedback payload." }, { status: 400 });
  }

  const target = resolveTarget(parsed.sessionId, parsed.turnId);
  const result = await submitFeedback(
    {
      sessionId: parsed.sessionId,
      turnId: parsed.turnId,
      thumb: parsed.thumb,
      // Off-taxonomy codes are dropped, never stored: a CATEGORICAL score with
      // an invented value pollutes the breakdown it exists to produce.
      reason: isReasonCode(parsed.reason) ? parsed.reason : undefined,
      comment: parsed.comment ?? undefined,
      surface: "partner",
    },
    target,
  );

  if (!result.ok) {
    // Shape only — never the visitor's words.
    console.error("PARTNER FEEDBACK failed:", {
      detail: result.detail,
      thumb: parsed.thumb,
      target: target.kind,
      commentChars: parsed.comment?.length ?? 0,
    });
    return Response.json({ detail: "Feedback could not be recorded." }, { status: 502 });
  }

  return Response.json({ ok: true, precision: result.target ?? "none" }, { status: 200 });
}
