"use client";

import { useEveAgent } from "eve/react";
import { ChatPanel } from "@/components/ChatPanel";
import { SessionBar } from "@/components/SessionBar";

export default function Page() {
  const agent = useEveAgent();

  return (
    <div className="flex h-screen" style={{ background: "var(--bg)" }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <SessionBar agent={agent} />
        <ChatPanel agent={agent} />
      </div>
    </div>
  );
}
