/**
 * specialist-preview.ts — pure event parsing for the "early answer" preview.
 *
 * THE LATENCY PROBLEM THIS SOLVES (measured 2026-09-08): the master relays every
 * specialist answer VERBATIM (instructions.md R7), which means the visitor waits
 * for (a) the specialist to finish AND (b) the master to re-generate the whole
 * text token by token — 10–20s of pure re-typing on a long partner answer. The
 * specialist's content exists on the wire much earlier:
 *
 *   - the FAQ subagent streams on its own CHILD SESSION; the parent stream's
 *     `subagent.called` carries `childSessionId`, and
 *     `GET /eve/v1/session/:childSessionId/stream` replays it from index 0
 *     (eve docs: subagents.mdx §streams, guides/client/streaming.mdx);
 *   - the partner answer arrives complete inside the `find_partners`
 *     `action.result` event, before the relay generation even starts.
 *
 * This module is the PURE half: given one wire event, say what preview content
 * it contributes. The React half (components/navio/useSpecialistPreview.ts)
 * owns subscriptions and state. Kept apart so the contract is unit-testable
 * without a DOM or a live stream.
 *
 * The preview NEVER replaces the relayed message — that stays the authoritative
 * answer (chips, feedback, history). The preview only fills the silent window
 * before the relay's own text starts streaming.
 */

/** Minimal structural view of a wire event — we never trust more shape than this. */
export type WireEvent = { type?: string; data?: unknown };

/** A `subagent.called` for the FAQ specialist → the child session to attach to. */
export function faqChildSessionFrom(event: WireEvent): string | null {
  if (event.type !== "subagent.called") return null;
  const d = event.data as { name?: unknown; childSessionId?: unknown } | undefined;
  if (d?.name !== "faq") return null;
  return typeof d.childSessionId === "string" && d.childSessionId.length > 0
    ? d.childSessionId
    : null;
}

/**
 * An `action.result` carrying specialist content → a keyed preview fragment.
 *
 * Two shapes matter (dist/src/runtime/actions/types.d.ts):
 *   { kind: "tool-result", toolName: "find_partners", output: { ok, answer } }
 *   { kind: "subagent-result", subagentName: "faq", output: <child's answer> }
 * The subagent fragment is only a FALLBACK — normally the live child stream has
 * already produced the same text — hence the stable key per call, so stream and
 * result never duplicate a section.
 */
export function previewFragmentFrom(
  event: WireEvent,
): { key: string; text: string } | null {
  if (event.type !== "action.result") return null;
  const d = event.data as { result?: unknown } | undefined;
  const result = d?.result as
    | {
        kind?: unknown;
        callId?: unknown;
        toolName?: unknown;
        subagentName?: unknown;
        output?: unknown;
      }
    | undefined;
  if (!result || typeof result !== "object") return null;
  const callId = typeof result.callId === "string" ? result.callId : "call";

  if (result.kind === "tool-result" && result.toolName === "find_partners") {
    const output = result.output as { ok?: unknown; answer?: unknown } | undefined;
    if (output?.ok === true && typeof output.answer === "string" && output.answer.trim()) {
      return { key: `partner:${callId}`, text: output.answer };
    }
    return null;
  }

  if (result.kind === "subagent-result" && result.subagentName === "faq") {
    const text = subagentOutputText(result.output);
    if (text) return { key: `faq:${callId}`, text };
    return null;
  }

  return null;
}

/** Best-effort text from a subagent result's JSON output — string, or common fields. */
function subagentOutputText(output: unknown): string | null {
  if (typeof output === "string") return output.trim() || null;
  if (output && typeof output === "object") {
    for (const field of ["text", "message", "answer", "output"]) {
      const value = (output as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/** Assistant text delta on the CHILD stream (`message.appended`). */
export function childTextDeltaFrom(event: WireEvent): string | null {
  if (event.type !== "message.appended") return null;
  const d = event.data as { messageDelta?: unknown } | undefined;
  return typeof d?.messageDelta === "string" && d.messageDelta.length > 0
    ? d.messageDelta
    : null;
}

/** True when a child-stream event marks the end of the child's work. */
export function isChildBoundary(event: WireEvent): boolean {
  return (
    event.type === "session.waiting" ||
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  );
}

/**
 * What the CURRENT turn has delegated to, read off the wire.
 *
 * Why the UI needs this: R2 obliges the master to announce a delegation
 * ("Einen Moment, ich schaue kurz nach.") — measured 2026-09-08, gpt-4o skips
 * that announcement on ~half of delegating turns no matter how the rule is
 * phrased, and the visitor then stares at typing dots for 10–20s. Same lesson
 * as the guaranteed chips: a prompt rule cannot deliver "always"; the UI can.
 * The widget uses this to render the announcement itself when the model stayed
 * silent.
 *
 * "Current turn" = everything after the LAST `message.received` (the user's
 * message that started the running turn). Partner beats faq for the copy choice
 * because its wait is the long one.
 */
/**
 * True once the CURRENT turn's delegation has produced at least one result.
 *
 * The widget uses this as the line between the turn's ANNOUNCEMENT phase (the
 * master's "Einen Moment…" filler, which is never rendered — owner decision
 * 2026-09-08: status text is hidden, only the loading bubble shows) and the
 * ANSWER phase (the relay carrying real content, which streams normally).
 */
export function currentTurnHasResult(events: readonly WireEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "message.received") return false;
    if (event.type === "action.result") return true;
  }
  return false;
}

export function currentTurnDelegationFrom(events: readonly WireEvent[]): "partner" | "faq" | null {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "message.received") {
      start = i;
      break;
    }
  }
  let seen: "partner" | "faq" | null = null;
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (event.type === "subagent.called") {
      const d = event.data as { name?: unknown } | undefined;
      if (d?.name === "faq" && seen === null) seen = "faq";
      continue;
    }
    if (event.type !== "actions.requested") continue;
    const d = event.data as { actions?: unknown } | undefined;
    const actions = Array.isArray(d?.actions) ? (d.actions as Record<string, unknown>[]) : [];
    for (const a of actions) {
      const name = typeof a.name === "string" ? a.name : typeof a.toolName === "string" ? a.toolName : "";
      if (name === "find_partners") return "partner";
      if (name === "faq" && seen === null) seen = "faq";
    }
  }
  return seen;
}
