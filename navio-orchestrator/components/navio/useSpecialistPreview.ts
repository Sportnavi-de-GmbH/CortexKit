"use client";

// The "early answer" preview hook — the React half of lib/specialist-preview.ts.
//
// While the master is mid-turn, this watches the parent's wire events and
// surfaces specialist content the moment it exists:
//   - `subagent.called` (faq) → attach to the child session's own stream and
//     accumulate its text deltas LIVE, while the child is still generating;
//   - `action.result` (find_partners / faq fallback) → lift the finished answer
//     out of the tool result, before the relay generation starts.
//
// The returned string is RAW specialist text (markers included) — the caller
// strips markers with parseMessageActions before rendering, same as any bubble.
// It resets to "" when the turn settles; rendering it is gated by the caller on
// the busy/waiting window, so the preview can never fight the real message.
//
// Failure posture: everything here is best-effort. A failed child-stream attach,
// a shape we don't recognize, an aborted fetch — all degrade to "no preview",
// which is exactly today's behavior (typing dots until the relay).

import { useEffect, useRef, useState } from "react";
import { Client } from "eve/client";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import {
  childTextDeltaFrom,
  faqChildSessionFrom,
  isChildBoundary,
  previewFragmentFrom,
  type WireEvent,
} from "../../lib/specialist-preview";

type Agent = UseEveAgentHelpers<EveMessageData>;

export function useSpecialistPreview(agent: Agent): string {
  const [sections, setSections] = useState<Record<string, string>>({});
  // How far into agent.events we have scanned — events are append-only per turn.
  const scanned = useRef(0);
  // Child sessions we already attached to (double-attach would double the text).
  const attached = useRef(new Set<string>());
  // Flipped on turn end/unmount so in-flight child readers stop appending.
  const generation = useRef(0);

  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  // Reset when the turn settles: the relayed message is now the answer.
  useEffect(() => {
    if (isBusy) return;
    generation.current += 1;
    attached.current.clear();
    setSections((s) => (Object.keys(s).length ? {} : s));
  }, [isBusy]);

  useEffect(() => {
    if (!isBusy) {
      scanned.current = agent.events.length;
      return;
    }
    const gen = generation.current;

    for (let i = scanned.current; i < agent.events.length; i++) {
      const event = agent.events[i] as WireEvent;

      const fragment = previewFragmentFrom(event);
      if (fragment) {
        setSections((s) =>
          // The live child stream (key `child:*`) usually already carries the
          // faq text; the result fragment is only the no-stream fallback.
          fragment.key.startsWith("faq:") && Object.keys(s).some((k) => k.startsWith("child:"))
            ? s
            : { ...s, [fragment.key]: fragment.text },
        );
      }

      const childId = faqChildSessionFrom(event);
      if (childId && !attached.current.has(childId)) {
        attached.current.add(childId);
        console.debug("[preview] attaching to faq child", childId);
        void followChild(childId, gen);
      }
    }
    scanned.current = agent.events.length;
    // agent.events is append-only while busy; length is the honest dependency.
  }, [agent.events.length, isBusy]);

  /**
   * Read the FAQ child session's stream from index 0 (eve replays durably) and
   * accumulate its assistant text into the preview — live, while it generates.
   */
  async function followChild(childSessionId: string, gen: number): Promise<void> {
    const key = `child:${childSessionId}`;
    try {
      const client = new Client({ host: window.location.origin });
      const session = client.session({ sessionId: childSessionId, streamIndex: 0 });
      for await (const raw of session.stream({ startIndex: 0 })) {
        if (generation.current !== gen) return; // turn is over — stop silently
        const event = raw as WireEvent;
        const delta = childTextDeltaFrom(event);
        if (delta) {
          setSections((s) => ({ ...s, [key]: (s[key] ?? "") + delta }));
        }
        if (isChildBoundary(event)) return;
      }
    } catch (err) {
      // Best-effort: no preview is just today's behavior. The action.result
      // fallback fragment may still fill this section.
      console.debug("[preview] child stream attach failed", err);
    }
  }

  return Object.values(sections)
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");
}
