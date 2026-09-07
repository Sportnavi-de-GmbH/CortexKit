"use client";

import { useState } from "react";
import { useEveAgent } from "eve/react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { DashboardView } from "@/components/dashboard/DashboardView";
import { ConversationDock } from "@/components/dashboard/ConversationDock";
import { DetailsOverlay, type DetailsTab } from "@/components/DetailsOverlay";

export default function Page() {
  const agent = useEveAgent();
  const [detailsTab, setDetailsTab] = useState<DetailsTab | null>(null);

  return (
    <div className="flex h-screen bg-stone-50">
      <Sidebar onOpenActivity={() => setDetailsTab("activity")} onOpenSettings={() => setDetailsTab("agent")} />
      <DashboardView agent={agent} onOpenActivity={() => setDetailsTab("activity")} onOpenSettings={() => setDetailsTab("agent")} />
      <ConversationDock agent={agent} />
      {detailsTab && <DetailsOverlay agent={agent} initialTab={detailsTab} onClose={() => setDetailsTab(null)} />}
    </div>
  );
}
