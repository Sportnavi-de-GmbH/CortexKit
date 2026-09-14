"use client";

// Client hook that makes the V3 partner workflow look like an eve agent to
// NavioWidget. Returns the same `UseEveAgentHelpers<EveMessageData>` shape as
// `useEveAgent`, so `<NavioWidget partnerAgent={…}>` accepts either without a
// change to the widget component. All projection logic is in
// lib/workflow-agent-state.ts (pure, tested); this file is only React glue.
//
// Differences from the eve path, by nature of V3: no streaming (status goes
// submitted → ready when the whole JSON answer arrives), no tool parts (so no
// partner cards), and `session.sessionId` is a client-generated id — V3 keeps
// no server session; the multi-turn state (`resume`) is held here.

import { useCallback, useMemo, useRef, useState } from "react";
import type { EveMessageData, UseEveAgentHelpers, UseEveAgentStatus } from "eve/react";
import {
  applyFailure,
  applyTrace,
  applyUserMessage,
  FAILED_MESSAGE,
  initialWorkflowState,
  type WorkflowAgentState,
  type WorkflowTraceLite,
} from "./workflow-agent-state";

export interface UseWorkflowAgentOptions {
  /** Same-origin endpoint that forwards to V3. */
  readonly endpoint?: string;
}

function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `wf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function useWorkflowAgent(options: UseWorkflowAgentOptions = {}): UseEveAgentHelpers<EveMessageData> {
  const endpoint = options.endpoint ?? "/api/partner/workflow";
  const [state, setState] = useState<WorkflowAgentState>(initialWorkflowState);
  const [status, setStatus] = useState<UseEveAgentStatus>("ready");
  const [sessionId, setSessionId] = useState<string>(newSessionId);
  const inFlight = useRef<AbortController | null>(null);
  // `send` needs the latest resume state without being recreated per render.
  const stateRef = useRef(state);
  stateRef.current = state;

  const send = useCallback<UseEveAgentHelpers<EveMessageData>["send"]>(
    async (input) => {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) return;
      if (inFlight.current) throw new Error("A turn is already in flight.");

      const resume = stateRef.current.resume;
      // Same turn id the reducer stamps on the messages (`turn_N`) — it is the
      // key feedback and monitoring use to name this answer server-side.
      const turnId = `turn_${stateRef.current.turn + 1}`;
      setState((s) => applyUserMessage(s, message));
      setStatus("submitted");
      const controller = new AbortController();
      inFlight.current = controller;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, sessionId, turnId, ...(resume ? { resume } : {}) }),
          signal: controller.signal,
        });
        if (!res.ok) {
          // 4xx carries a user-actionable detail from our own route (too long,
          // origin); anything else is an outage and gets the generic line.
          let detail = FAILED_MESSAGE;
          if (res.status < 500) {
            try {
              const body = (await res.json()) as { detail?: string };
              if (body.detail) detail = body.detail;
            } catch {
              /* non-JSON error body */
            }
          }
          throw new Error(detail);
        }
        const trace = (await res.json()) as WorkflowTraceLite;
        setState((s) => applyTrace(s, trace));
        setStatus(trace.status === "failed" ? "error" : "ready");
      } catch (e) {
        if (controller.signal.aborted) {
          setStatus("ready");
          return;
        }
        const error = e instanceof Error ? e : new Error(String(e));
        setState((s) => applyFailure(s, error));
        setStatus("error");
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    [endpoint, sessionId],
  );

  const stop = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);

  const reset = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setState(initialWorkflowState());
    setStatus("ready");
    setSessionId(newSessionId());
  }, []);

  return useMemo<UseEveAgentHelpers<EveMessageData>>(
    () => ({
      data: { messages: state.messages },
      error: state.error,
      events: [],
      session: { sessionId, streamIndex: state.turn },
      status,
      send,
      stop,
      reset,
    }),
    [state, status, sessionId, send, stop, reset],
  );
}
