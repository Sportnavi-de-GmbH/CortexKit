"use client";

import { useState } from "react";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import { useAgentInfo } from "@/lib/dev-console/use-agent-info";
import { DashboardHeader } from "./DashboardHeader";
import { AgentActionsFeed } from "./AgentActionsFeed";
import { PartnerResolution } from "./PartnerResolution";
import { ContextInspector } from "./ContextInspector";

type Agent = UseEveAgentHelpers<EveMessageData>;

export function DashboardView({
  agent,
  onOpenActivity,
  onOpenSettings,
}: {
  agent: Agent;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const info = useAgentInfo();
  const sessionId = agent.session?.sessionId;
  const isLive = agent.status === "submitted" || agent.status === "streaming";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DashboardHeader
        title="Partner Agent Console"
        modelId={info?.agent?.model?.id}
        isConnected={Boolean(sessionId)}
        isLive={isLive}
        query={query}
        onQueryChange={setQuery}
        onOpenSettings={onOpenSettings}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-hidden bg-stone-50 p-6 pb-28 lg:grid-cols-3">
        <AgentActionsFeed agent={agent} query={query} onOpenActivity={onOpenActivity} />
        <PartnerResolution agent={agent} query={query} />
        <ContextInspector agent={agent} info={info} />
      </div>
    </div>
  );
}
