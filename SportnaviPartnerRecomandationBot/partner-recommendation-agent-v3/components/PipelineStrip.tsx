"use client";
import type { StageRecord } from "../workflow/types";
import { statusColor } from "../lib/ui/format";

/** Compact horizontal overview of the six stages: title · status colour · ms. */
export function PipelineStrip({ stages, onJump }: { stages: StageRecord[]; onJump?: (id: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onJump?.(s.id)}
            title={`${s.title}: ${s.status}${s.error ? ` — ${s.error.message}` : ""}${s.warnings.length ? ` — ${s.warnings.length} warning(s)` : ""}`}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${statusColor(s.status)}`}
          >
            <span className="font-semibold">{i + 1}. {s.title}</span>
            <span className="opacity-70">{s.status === "skipped" ? "skipped" : `${s.durationMs} ms`}</span>
          </button>
          {i < stages.length - 1 && <span className="text-zinc-400">→</span>}
        </div>
      ))}
    </div>
  );
}
