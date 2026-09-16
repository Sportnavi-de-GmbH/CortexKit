// Persist every 👍/👎 (both surfaces) against its trace in the monitoring
// database. Additive to the Langfuse scoring in app/api/feedback/route.ts:
// never throws, never changes the response, no-op without credentials.
import type { FeedbackRequest } from "../feedback";
import { agentVersion as readAgentVersion } from "./env";
import { store as defaultStore, type MonitoringStore } from "./store";

export async function recordFeedback(
  parsed: FeedbackRequest,
  deps: { store?: MonitoringStore; agentVersion?: string } = {},
): Promise<{ linked: boolean; traceId?: string } | undefined> {
  const store = deps.store ?? defaultStore;
  if (!store.enabled) return undefined;
  try {
    const r = await store.recordFeedback({
      session_id: parsed.sessionId,
      turn_id: parsed.turnId,
      agent: parsed.surface === "partner" ? "partner" : "faq",
      thumb: parsed.thumb,
      reason: parsed.reason ?? null,
      comment: parsed.comment ?? null,
      epoch: parsed.epoch ?? 0,
      agent_version: deps.agentVersion ?? readAgentVersion(),
    });
    return r ? { linked: r.linked, traceId: r.traceId } : undefined;
  } catch (e) {
    console.error("[monitoring] recordFeedback failed:", { error: e instanceof Error ? e.name : "unknown" });
    return undefined;
  }
}

/** The monitoring system's own log line (events table); flushed with the next trace write. */
export async function noteEvent(
  type: string,
  payload: Record<string, unknown>,
  sessionId?: string,
  deps: { store?: MonitoringStore } = {},
): Promise<void> {
  const store = deps.store ?? defaultStore;
  if (!store.enabled) return;
  try {
    await store.logEvent({ type, session_id: sessionId, payload });
  } catch {
    /* never */
  }
}
