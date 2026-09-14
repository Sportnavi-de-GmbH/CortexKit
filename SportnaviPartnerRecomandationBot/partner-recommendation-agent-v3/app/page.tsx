"use client";
import { useEffect, useState } from "react";
import type { WorkflowConfig } from "../config/workflow.config";
import type { DetectCityOutput, NearbyCitiesOutput, ReformulateOutput, RerankOutput, RespondOutput, SearchOutput, WorkflowTrace } from "../workflow/types";
import { statusColor } from "../lib/ui/format";
import { QueryForm } from "../components/QueryForm";
import { ConfigPanel } from "../components/ConfigPanel";
import { StageSection } from "../components/StageSection";
import { RunHistory } from "../components/RunHistory";
import { PipelineStrip } from "../components/PipelineStrip";
import { DetectCityView } from "../components/stages/DetectCityView";
import { ReformulateView } from "../components/stages/ReformulateView";
import { NearbyCitiesView } from "../components/stages/NearbyCitiesView";
import { SearchView } from "../components/stages/SearchView";
import { RerankView } from "../components/stages/RerankView";
import { RespondView } from "../components/stages/RespondView";

export default function Page() {
  const [defaults, setDefaults] = useState<WorkflowConfig | null>(null);
  const [envSet, setEnvSet] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Partial<WorkflowConfig>>({});
  const [query, setQuery] = useState("");
  const [homeCity, setHomeCity] = useState("");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<WorkflowTrace[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workflow").then((r) => r.json()).then((b) => { setDefaults(b.defaults); setEnvSet(b.envSet); }).catch((e) => setFetchError(String(e)));
  }, []);

  async function run() {
    setRunning(true); setFetchError(null);
    try {
      const res = await fetch("/api/workflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, homeCity: homeCity || undefined, config: overrides }) });
      const body = await res.json();
      if (!res.ok) { setFetchError(body.error ?? `HTTP ${res.status}`); return; }
      const trace = body as WorkflowTrace;
      setRuns((r) => [trace, ...r].slice(0, 10));
      setSelected(trace.runId);
    } catch (e) { setFetchError(String(e)); } finally { setRunning(false); }
  }

  const trace = runs.find((r) => r.runId === selected);
  const out = <T,>(id: string) => trace?.stages.find((s) => s.id === id)?.output as T | undefined;
  const jump = (id: string) => document.getElementById(`stage-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Partner Retrieval V3 — Workflow Lab</h1>
        <span className="text-xs text-zinc-500">Detect city → Reformulate → Nearby cities → Embed once + search → Rerank → Answer</span>
      </header>
      <QueryForm query={query} setQuery={setQuery} homeCity={homeCity} setHomeCity={setHomeCity} running={running} onRun={run} />
      {defaults && <ConfigPanel defaults={defaults} envSet={envSet} overrides={overrides} setOverrides={setOverrides} />}
      {fetchError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{fetchError}</p>}
      <RunHistory runs={runs} selected={selected} onSelect={setSelected} />
      {trace && (
        <>
          <div className="flex items-center gap-3 text-sm">
            <span className={`rounded px-2 py-0.5 font-medium ${statusColor(trace.status)}`}>{trace.status}</span>
            <span>{trace.totalMs} ms</span>
            {trace.clarification && <span className="text-amber-700 dark:text-amber-300">{trace.clarification}</span>}
            {trace.error && <span className="text-red-700 dark:text-red-300">{trace.error.message}</span>}
            <button type="button" className="ml-auto rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" onClick={() => navigator.clipboard.writeText(JSON.stringify(trace, null, 2))}>Copy trace JSON</button>
          </div>
          <PipelineStrip stages={trace.stages} onJump={jump} />
          {trace.stages.map((s, i) => (
            <div key={`${trace.runId}-${s.id}`} id={`stage-${s.id}`} className="scroll-mt-4">
              <StageSection index={i + 1} stage={s}>
                {s.id === "detect-city" && !!s.output && <DetectCityView output={out<DetectCityOutput>(s.id)!} />}
                {s.id === "reformulate" && !!s.output && <ReformulateView output={out<ReformulateOutput>(s.id)!} />}
                {s.id === "nearby-cities" && !!s.output && <NearbyCitiesView output={out<NearbyCitiesOutput>(s.id)!} />}
                {s.id === "search" && !!s.output && <SearchView output={out<SearchOutput>(s.id)!} />}
                {s.id === "rerank" && !!s.output && <RerankView output={out<RerankOutput>(s.id)!} />}
                {s.id === "respond" && !!s.output && <RespondView output={out<RespondOutput>(s.id)!} />}
              </StageSection>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
