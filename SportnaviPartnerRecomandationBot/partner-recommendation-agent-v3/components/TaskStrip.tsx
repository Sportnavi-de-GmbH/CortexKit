"use client";
import type { TaskRun } from "../workflow/types";
import { statusColor } from "../lib/ui/format";

/** One chip per executed task: label · status · ms. Selecting one shows its stages below. */
export function TaskStrip({ tasks, selected, onSelect }: { tasks: TaskRun[]; selected: number; onSelect: (i: number) => void }) {
  if (tasks.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold uppercase tracking-wide text-zinc-500">Tasks</span>
      {tasks.map((t, i) => (
        <button
          key={t.task.id}
          type="button"
          onClick={() => onSelect(i)}
          aria-pressed={i === selected}
          className={`flex items-center gap-2 rounded-full border px-3 py-1 ${i === selected ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "border-zinc-300 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"}`}
        >
          <span className="font-semibold">{t.task.label}</span>
          <span className={`rounded px-1.5 py-0.5 font-medium ${statusColor(t.status)}`}>{t.status}</span>
          <span className="tabular-nums text-zinc-500">{t.totalMs} ms</span>
        </button>
      ))}
    </div>
  );
}
