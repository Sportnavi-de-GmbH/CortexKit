"use client";
import { useEffect, useState } from "react";
import type { WorkflowConfig } from "../config/workflow.config";
import type { DecomposeOutput, DetectCityOutput, NearbyCitiesOutput, ReformulateOutput, ResumeState, RerankOutput, RespondOutput, SearchOutput, WorkflowTrace } from "../workflow/types";
import ReactMarkdown from "react-markdown";
import { statusColor } from "../lib/ui/format";
import { QueryForm } from "../components/QueryForm";
import { ConfigPanel } from "../components/ConfigPanel";
import { StageSection } from "../components/StageSection";
import { RunHistory } from "../components/RunHistory";
import { PipelineStrip } from "../components/PipelineStrip";
import { TaskStrip } from "../components/TaskStrip";
import { DecomposeView } from "../components/stages/DecomposeView";
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
  const [resume, setResume] = useState<ResumeState | null>(null);
  const [taskIdx, setTaskIdx] = useState(0);

  useEffect(() => {
    fetch("/api/workflow").then((r) => r.json()).then((b) => { setDefaults(b.defaults); setEnvSet(b.envSet); }).catch((e) => setFetchError(String(e)));
  }, []);

  async function run() {
    setRunning(true); setFetchError(null);
    try {
      const res = await fetch("/api/workflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, homeCity: homeCity || undefined, resume: resume ?? undefined, config: overrides }) });
      const body = await res.json();
      if (!res.ok) { setFetchError(body.error ?? `HTTP ${res.status}`); return; }
      const trace = body as WorkflowTrace;
      setRuns((r) => [trace, ...r].slice(0, 10));
      setSelected(trace.runId);
      setTaskIdx(0);
      setResume(trace.pending.length || trace.deferred.length ? { pending: trace.pending, deferred: trace.deferred } : null);
    } catch (e) { setFetchError(String(e)); } finally { setRunning(false); }
  }

  const trace = runs.find((r) => r.runId === selected);
  const taskRun = trace?.tasks[Math.min(taskIdx, Math.max(0, (trace?.tasks.length ?? 1) - 1))];
  const stages = taskRun?.stages ?? [];
  const out = <T,>(id: string) => stages.find((s) => s.id === id)?.output as T | undefined;
  const jump = (id: string) => document.getElementById(`stage-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Partner Retrieval V3 — Workflow Lab</h1>
        <span className="text-xs text-zinc-500">Decompose → Detect city → Reformulate → Nearby cities → Embed once + search → Rerank → Answer (≤ 3 tasks in parallel)</span>
      </header>
      <QueryForm query={query} setQuery={setQuery} homeCity={homeCity} setHomeCity={setHomeCity} running={running} onRun={run} resume={resume} onClearResume={() => setResume(null)} />
      {defaults && <ConfigPanel defaults={defaults} envSet={envSet} overrides={overrides} setOverrides={setOverrides} />}
      {fetchError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{fetchError}</p>}
      <RunHistory runs={runs} selected={selected} onSelect={(id) => { setSelected(id); setTaskIdx(0); }} />
      {trace && (
        <>
          <div className="flex items-center gap-3 text-sm">
            <span className={`rounded px-2 py-0.5 font-medium ${statusColor(trace.status)}`}>{trace.status}</span>
            <span>{trace.totalMs} ms</span>
            <span className="text-zinc-500">{trace.tasks.length} task(s) · {trace.deferred.length} deferred · {trace.pending.length} pending</span>
            {trace.error && <span className="text-red-700 dark:text-red-300">{trace.error.message}</span>}
            <button type="button" className="ml-auto rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" onClick={() => navigator.clipboard.writeText(JSON.stringify(trace, null, 2))}>Copy trace JSON</button>
          </div>
          {(trace.answer || trace.clarification) && (
            <div className="rounded border border-emerald-200 bg-emerald-50/40 p-4 text-sm leading-6 dark:border-emerald-900 dark:bg-emerald-950/20 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_a]:underline">
              <ReactMarkdown>{trace.answer ?? trace.clarification ?? ""}</ReactMarkdown>
            </div>
          )}
          <div id="stage-decompose" className="scroll-mt-4">
            <StageSection index={0} stage={trace.decompose}>
              {!!trace.decompose.output && <DecomposeView output={trace.decompose.output as DecomposeOutput} />}
            </StageSection>
          </div>
          <TaskStrip tasks={trace.tasks} selected={taskIdx} onSelect={setTaskIdx} />
          {taskRun && trace.tasks.length > 1 && (
            <p className="text-xs text-zinc-500">Showing task <b>{taskRun.task.label}</b> — query: <i>{taskRun.task.query}</i></p>
          )}
          <PipelineStrip stages={stages} onJump={jump} />
          {stages.map((s, i) => (
            <div key={`${trace.runId}-${taskRun?.task.id}-${s.id}`} id={`stage-${s.id}`} className="scroll-mt-4">
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
