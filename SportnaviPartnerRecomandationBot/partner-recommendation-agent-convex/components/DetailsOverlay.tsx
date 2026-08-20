"use client";

/**
 * Full-detail view, reached from the sidebar's Activity/Settings icons. The
 * Context tab was retired once the dashboard's Active Context Window
 * Inspector card took over that role inline — this overlay now covers what
 * that card doesn't: the full raw event log (Timeline) and the full agent
 * info (tools/skills/subagents/channels, AgentInfoPanel), both unchanged.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { UseEveAgentHelpers, EveMessageData } from "eve/react";
import { Timeline } from "./Timeline";
import { AgentInfoPanel } from "./AgentInfoPanel";

type Agent = UseEveAgentHelpers<EveMessageData>;
export type DetailsTab = "activity" | "agent";

export function DetailsOverlay({
  agent,
  initialTab,
  onClose,
}: {
  agent: Agent;
  initialTab: DetailsTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailsTab>(initialTab);

  useEffect(() => setTab(initialTab), [initialTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-stone-50">
      <header className="flex shrink-0 items-center gap-1 border-b border-stone-200 bg-white px-5 py-3 shadow-sm">
        <span className="font-headline mr-4 text-[14px] font-semibold text-stone-900">Details</span>
        <div className="flex items-center gap-1 rounded-lg bg-stone-100 p-1">
          <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
            Activity
          </TabButton>
          <TabButton active={tab === "agent"} onClick={() => setTab("agent")}>
            Agent
          </TabButton>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>

      {tab === "activity" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-5">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
            <Timeline events={agent.events} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-5">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
            <AgentInfoPanel />
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active ? "bg-white text-teal-600 shadow-sm" : "text-stone-500 hover:text-stone-700"
      }`}
    >
      {children}
    </button>
  );
}
