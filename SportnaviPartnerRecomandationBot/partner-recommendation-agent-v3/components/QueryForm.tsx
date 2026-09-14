"use client";
import { EXAMPLE_QUERIES } from "../lib/ui/examples";

export interface QueryFormProps {
  query: string;
  setQuery: (q: string) => void;
  homeCity: string;
  setHomeCity: (c: string) => void;
  running: boolean;
  onRun: () => void;
}

const INPUT = "w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function QueryForm({ query, setQuery, homeCity, setHomeCity, running, onRun }: QueryFormProps) {
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
