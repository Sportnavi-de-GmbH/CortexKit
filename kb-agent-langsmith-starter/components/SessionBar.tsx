"use client";

import { useMemo, useState } from "react";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import type { HandleMessageStreamEvent } from "eve/client";

type Agent = UseEveAgentHelpers<EveMessageData>;

export function SessionBar({ agent }: { agent: Agent }) {
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
      <span
        className="font-headline text-[14px] font-semibold tracking-tight"
        style={{ color: "var(--text)" }}
        translate="no"
      >
        KB Agent
      </span>
      <span className="hidden truncate text-[11px] md:block" style={{ color: "var(--text-faint)" }}>
        LangSmith starter testbed — answers from the injected knowledge base only
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-4">
        <StatusPill status={agent.status} />
        {sessionId && (
          <button
            type="button"
            onClick={copySessionId}
            className="mono rounded-md px-1 text-[11px] transition-colors hover:text-(--text-dim)"
            style={{ color: "var(--text-faint)" }}
            aria-label={`Copy session id ${sessionId}`}
          >
            <span translate="no">{copied ? "Copied!" : `sid: ${sessionId.slice(0, 12)}`}</span>
          </button>
        )}
        {usage.inputTokens > 0 && (
          <span
            className="mono text-[11px]"
            style={{ color: "var(--text-faint)" }}
            title={`${usage.inputTokens.toLocaleString()} input tokens, ${usage.outputTokens.toLocaleString()} output tokens`}
          >
            {usage.inputTokens.toLocaleString()}↑ {usage.outputTokens.toLocaleString()}↓
          </span>
        )}
        {isLive && (
          <button
            type="button"
            onClick={() => agent.stop()}
            className="rounded-md px-1 text-[11px] font-medium uppercase tracking-wider transition-colors hover:text-rose-700"
            style={{ color: "var(--red)" }}
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => agent.reset()}
          className="rounded-md px-1 text-[11px] font-medium uppercase tracking-wider transition-colors hover:text-(--text-dim)"
          style={{ color: "var(--text-faint)" }}
        >
          New Session
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const isLive = status === "submitted" || status === "streaming";
  const color = status === "error" ? "var(--red)" : isLive ? "var(--accent)" : "var(--text-faint)";
  return (
    <span
      role="status"
      aria-label={`Agent status: ${status}`}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
      style={{ background: isLive ? "var(--accent-dim)" : "var(--bg-panel-raised)", color }}
    >
      <span
        className={isLive ? "animate-pulse" : ""}
        style={{ width: 6, height: 6, borderRadius: 999, background: color }}
        aria-hidden="true"
      />
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
