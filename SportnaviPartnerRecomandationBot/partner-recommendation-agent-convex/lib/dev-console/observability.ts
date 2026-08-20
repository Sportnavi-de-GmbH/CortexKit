/**
 * lib/dev-console/observability.ts
 *
 * A tiny, read-only lens over the live agent stream for the dev console's
 * Context Inspector card. Only reads what eve already emits — changes
 * nothing, stores nothing. Ported from dev-console/lib/observability.ts,
 * trimmed to what this project's dashboard actually uses (namespaced under
 * lib/dev-console/ so it doesn't collide with this project's existing
 * lib/observability.ts, the server-side partner-resolution event logger).
 */
import type { HandleMessageStreamEvent } from "eve/client";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** The most recent provider-measured context size (last model call this session). */
export function currentContextTokens(events: readonly HandleMessageStreamEvent[]): number {
  let current = 0;
  for (const event of events) {
    if (event.type === "step.completed" && event.data.usage?.inputTokens != null) {
      current = event.data.usage.inputTokens;
    }
  }
  return current;
}

/** Minimal shape of the /eve/v1/info payload this module reads. */
export interface AgentInfoLike {
  agent?: { name?: string; model?: { id?: string; contextWindowTokens?: number } };
  instructions?: { static?: { markdown?: string } | null };
  tools?: { available?: ReadonlyArray<{ name: string; description?: string }> };
}

export function formatTokens(n: number): string {
  return n.toLocaleString();
}
