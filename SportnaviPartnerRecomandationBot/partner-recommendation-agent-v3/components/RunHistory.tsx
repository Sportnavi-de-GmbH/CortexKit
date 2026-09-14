"use client";
import type { WorkflowTrace } from "../workflow/types";
import { statusColor } from "../lib/ui/format";

export interface RunHistoryProps {
  runs: WorkflowTrace[];
  selected: string | undefined;
  onSelect: (runId: string) => void;
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
}

export function RunHistory({ runs, selected, onSelect }: RunHistoryProps) {
  if (runs.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {runs.slice(0, 10).map((r) => {
        const q = r.input.query.length > 40 ? `${r.input.query.slice(0, 40)}…` : r.input.query;
        const active = r.runId === selected;
        return (
          <button
            key={r.runId}
            type="button"
            onClick={() => onSelect(r.runId)}
            title={r.input.query}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs ${active ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "border-zinc-300 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"}`}
          >
            <span className="tabular-nums text-zinc-500">{hhmmss(r.startedAt)}</span>
            <span className={`rounded px-1.5 py-0.5 font-medium ${statusColor(r.status)}`}>{r.status}</span>
            <span className="tabular-nums text-zinc-500">{r.totalMs} ms</span>
            <span className="max-w-64 truncate">{q}</span>
          </button>
        );
      })}
    </div>
  );
}
