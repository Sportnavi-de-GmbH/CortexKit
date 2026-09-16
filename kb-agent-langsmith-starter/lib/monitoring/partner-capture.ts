// Glue between the V3 adapter (lib/partner-workflow.ts) and the monitoring
// store: one adapter round-trip → one TraceDraft → one write. Never throws;
// no-op without credentials; the write is raced against a cap so a slow
// database can delay the visitor's answer by at most `capMs`.
import type { WorkflowObservation } from "../partner-workflow";
import { agentVersion, monitoringEnvironment } from "./env";
import { store as defaultStore, type MonitoringStore } from "./store";
import { mapV3Trace, mapV3UpstreamError, type V3WorkflowTrace } from "./v3-mapper";

function isTrace(v: unknown): v is V3WorkflowTrace {
  return typeof v === "object" && v !== null && typeof (v as { runId?: unknown }).runId === "string";
}

export async function captureWorkflow(
  o: WorkflowObservation,
  deps: { store?: MonitoringStore; capMs?: number } = {},
): Promise<void> {
  const store = deps.store ?? defaultStore;
  if (!store.enabled) return;
  try {
    const parsed = o.status >= 200 && o.status < 300 && isTrace(o.trace) ? o.trace : undefined;
    if (!o.sessionId || !o.turnId) {
      console.warn("[monitoring] partner turn without ids", { hasSession: Boolean(o.sessionId), hasTurn: Boolean(o.turnId) });
    }
    const sessionId = o.sessionId ?? `wf_anon_${parsed?.runId ?? Date.now()}`;
    const turnId = o.turnId ?? "turn_0";
    const common = {
      sessionId,
      turnId,
      turnIndex: /^turn_\d+$/.test(turnId) ? Number(turnId.slice(5)) : undefined,
      origin: o.origin,
      agentVersion: agentVersion(),
      environment: monitoringEnvironment(),
    };
    const draft = parsed
      ? mapV3Trace({ ...common, trace: parsed, upstreamStatus: o.status })
      : mapV3UpstreamError({
          ...common,
          userInput: o.message,
          status: o.status,
          body: o.detail ?? "",
          startedAt: o.startedAt,
        });
    await Promise.race([store.writeTrace(draft), new Promise<void>((r) => setTimeout(r, deps.capMs ?? 5000))]);
  } catch (e) {
    console.error("[monitoring] partner capture failed:", { error: e instanceof Error ? e.name : "unknown" });
  }
}
