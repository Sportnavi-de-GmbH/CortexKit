"use client";
import { EXAMPLE_QUERIES } from "../lib/ui/examples";
import type { ResumeState } from "../workflow/types";

export interface QueryFormProps {
  query: string;
  setQuery: (q: string) => void;
  homeCity: string;
  setHomeCity: (c: string) => void;
  running: boolean;
  onRun: () => void;
  resume: ResumeState | null;
  onClearResume: () => void;
}

const INPUT = "w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function QueryForm({ query, setQuery, homeCity, setHomeCity, running, onRun, resume, onClearResume }: QueryFormProps) {
  const canRun = !running && query.trim().length > 0;

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canRun) {
      e.preventDefault();
      onRun();
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Query</span>
        <textarea
          className={INPUT}
          rows={3}
          value={query}
          placeholder='e.g. "Yoga in Bochum" — Ctrl/Cmd+Enter runs'
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {EXAMPLE_QUERIES.map((q) => (
          <button
            key={q}
            type="button"
            title={q}
            onClick={() => setQuery(q)}
            className={`max-w-xs truncate rounded-full border px-3 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${q === query ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "border-zinc-300 dark:border-zinc-700"}`}
          >
            {q}
          </button>
        ))}
      </div>
      {resume && (resume.pending.length > 0 || resume.deferred.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">Weiter mit:</span>
          <span>{resume.pending.length} offen{resume.pending.length ? ` (${resume.pending.map((p) => p.label).join(", ")})` : ""}</span>
          <span>·</span>
          <span>{resume.deferred.length} zurückgestellt{resume.deferred.length ? ` (${resume.deferred.map((d) => d.label).join(", ")})` : ""}</span>
          <button type="button" onClick={onClearResume} aria-label="Resume-Status verwerfen" className="ml-auto rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40">×</button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Home city (fallback when no city is mentioned)</span>
          <input className={INPUT} value={homeCity} placeholder="e.g. Bochum" onChange={(e) => setHomeCity(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        <button
          type="button"
          disabled={!canRun}
          onClick={onRun}
          className="rounded bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  );
}
