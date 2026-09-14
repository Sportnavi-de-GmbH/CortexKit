"use client";
import { useState } from "react";
import type { StageRecord } from "../workflow/types";
import { statusColor } from "../lib/ui/format";
import { JsonBlock } from "./JsonBlock";

export function StageSection({ index, stage, children }: { index: number; stage: StageRecord; children?: React.ReactNode }) {
  const [open, setOpen] = useState(stage.status !== "skipped");
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="text-zinc-400">{open ? "▼" : "▶"}</span>
        <span className="font-semibold">{index}. {stage.title}</span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusColor(stage.status)}`}>{stage.status}</span>
        <span className="ml-auto text-xs text-zinc-500">{stage.durationMs} ms</span>
      </button>
      {open && stage.status !== "skipped" && (
        <div className="space-y-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {stage.error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">✖ {stage.error.message}</p>}
          {stage.warnings.length > 0 && (
            <ul className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {stage.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
            </ul>
          )}
          {stage.counts && (
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(stage.counts).map(([k, v]) => <span key={k} className="rounded bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">{k}: <b>{v}</b></span>)}
            </div>
          )}
          {children}
          <div className="grid gap-2 md:grid-cols-2">
            <JsonBlock label="Input" value={stage.input} />
            <JsonBlock label="Output (raw)" value={stage.output} />
            <JsonBlock label="Config used" value={stage.config} />
            <JsonBlock label="Filters" value={stage.filters} />
          </div>
        </div>
      )}
    </section>
  );
}
