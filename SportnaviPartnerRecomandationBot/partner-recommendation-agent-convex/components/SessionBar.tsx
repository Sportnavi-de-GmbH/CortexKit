"use client";

import { useMemo, useState } from "react";
import type { UseEveAgentHelpers } from "eve/react";
import type { EveMessageData } from "eve/react";
import type { HandleMessageStreamEvent } from "eve/client";

type Agent = UseEveAgentHelpers<EveMessageData>;

export function SessionBar({ agent, onOpenObservability }: { agent: Agent; onOpenObservability?: () => void }) {
  const [copied, setCopied] = useState(false);
  const usage = useMemo(() => cumulativeUsage(agent.events), [agent.events]);

  const sessionId = agent.session?.sessionId;
  const isLive = agent.status === "submitted" || agent.status === "streaming";

  function copySessionId() {
    if (!sessionId) return;
    void navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div
      className="flex h-14 shrink-0 items-center gap-3 px-5"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
    >
      <span className="text-[14px] font-semibold tracking-tight font-headline" style={{ color: "var(--text)" }}>
        Partner Agent
      </span>

      <div className="ml-auto flex items-center gap-4">
        <StatusPill status={agent.status} />
        {sessionId && (
          <button
            type="button"
            onClick={copySessionId}
            className="mono text-[11px] transition-colors"
            style={{ color: "var(--text-faint)" }}
            title="Copy session id"
          >
            {copied ? "copied!" : `sid: ${sessionId.slice(0, 12)}`}
          </button>
        )}
        {usage.inputTokens > 0 && (
          <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
            {usage.inputTokens.toLocaleString()}↑ {usage.outputTokens.toLocaleString()}↓
          </span>
        )}
        {isLive && (
          <button
            type="button"
            onClick={() => agent.stop()}
            className="text-[11px] font-medium uppercase tracking-wider transition-colors"
            style={{ color: "var(--red)" }}
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => agent.reset()}
          className="text-[11px] font-medium uppercase tracking-wider transition-colors"
          style={{ color: "var(--text-faint)" }}
        >
          New session
        </button>
        {onOpenObservability && (
          <>
            <div style={{ width: 1, height: 16, background: "var(--border)" }} />
            <button
              type="button"
              onClick={onOpenObservability}
              className="text-[11px] font-medium transition-colors"
              style={{ color: "var(--text-faint)" }}
              title="Open full details"
            >
              Details
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const isLive = status === "submitted" || status === "streaming";
  const color = status === "error" ? "var(--red)" : isLive ? "var(--accent)" : "var(--text-faint)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
      style={{ background: isLive ? "var(--accent-dim)" : "var(--bg-panel-raised)", color }}
    >
      <span className={isLive ? "animate-pulse" : ""} style={{ width: 6, height: 6, borderRadius: 999, background: color }} />
      {status}
    </span>
  );
}

export function cumulativeUsage(events: readonly HandleMessageStreamEvent[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.type === "step.completed" && event.data.usage) {
      inputTokens += event.data.usage.inputTokens ?? 0;
      outputTokens += event.data.usage.outputTokens ?? 0;
    }
  }
  return { inputTokens, outputTokens };
}
