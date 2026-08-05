"use client";

/** Best-effort fetch of the /eve/v1/info payload — model, tools, skills, subagents. */
import { useEffect, useState } from "react";
import type { AgentInfoLike } from "./observability";

export function useAgentInfo(): AgentInfoLike | null {
  const [info, setInfo] = useState<AgentInfoLike | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/eve/v1/info")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setInfo(data as AgentInfoLike);
      })
      .catch(() => {
        /* info is optional — consumers degrade gracefully without it */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
