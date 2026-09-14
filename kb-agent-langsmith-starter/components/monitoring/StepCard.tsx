"use client";

// One step of the timeline: plain-language header, proportional duration bar,
// and — when open — Input / Output (table view where the data is a list),
// Config, Warnings, Error, and a Technical details disclosure.
import { AlertTriangle, ChevronDown, ChevronRight, Database, Layers, MessageSquare, Send, Shuffle, Sparkles, Wrench } from "lucide-react";
import type { StepNode } from "@/lib/monitoring/query";
import type { StepKind } from "@/lib/monitoring/types";
import { JsonView } from "./JsonView";
import { KIND_LABEL, durationPct, previewOf, tableFor } from "./timeline-model";
import { StatusPill, fmtMs, fmtUsd } from "./ui";

const ICON: Record<StepKind, typeof Sparkles> = {
  request: MessageSquare, llm: Sparkles, tool: Wrench, retrieval: Database, transform: Shuffle, response: Send, error: AlertTriangle, group: Layers,
};

const BAR: Record<string, string> = {
  ok: "bg-(--brand-green)", warning: "bg-(--brand-orange)", error: "bg-(--red)", skipped: "bg-(--border-strong)",
};

function Table({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const cell = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : v === null || v === undefined ? "" : String(v));
  return (
    <div className="overflow-x-auto rounded-xl border border-(--border)">
      <table className="w-full text-xs">
        <thead className="bg-(--surface-muted) text-left text-(--fg-subtle)">
          <tr>{columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r, i) => (
            <tr key={i} className="border-t border-(--border)">{columns.map((c) => <td key={c} className="px-2 py-1 whitespace-nowrap">{cell(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && <div className="px-2 py-1 text-[11px] text-(--fg-subtle)">Showing 50 of {rows.length} — the raw JSON below has all rows.</div>}
    </div>
  );
}

export interface StepCardProps {
  step: StepNode;
  totalMs: number;
  open: boolean;
  focused: boolean;
  depth: number;
  onToggle: (id: string) => void;
  isOpen: (id: string) => boolean;
  focusedId: string | null;
}

export function StepCard(p: StepCardProps) {
  const { step } = p;
  const Icon = ICON[step.kind] ?? Sparkles;
  const isGroup = step.kind === "group";
  const table = p.open ? tableFor(step) : null;
  const meta = step.metadata ?? {};
  const config = (meta as { config?: Record<string, unknown> }).config;
  return (
    <div
      id={`step-${step.id}`}
      className={`rounded-2xl border bg-(--surface) ${p.focused ? "border-(--brand-green) ring-2 ring-(--brand-green)/30" : "border-(--border)"} ${p.depth > 0 ? "" : "soft-shadow"}`}
    >
      <button type="button" onClick={() => p.onToggle(step.id)} className="flex w-full items-start gap-3 p-3 text-left" aria-expanded={p.open}>
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--surface-muted) text-(--fg-muted)">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-sm font-semibold">{step.title}</span>
            <span className="text-[11px] uppercase tracking-wide text-(--fg-subtle)">{KIND_LABEL[step.kind]}</span>
            {step.tool_name && <span className="rounded-md bg-(--surface-muted) px-1.5 font-mono text-[11px]">{step.tool_name}</span>}
            <span className="ml-auto flex items-center gap-2 text-xs text-(--fg-muted)">
              {fmtMs(step.duration_ms)}
              <StatusPill status={step.status} />
              {p.open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-(--fg-muted)">{step.purpose}</span>
          {!p.open && !isGroup && (step.output ?? step.input) != null && (
            <span className="mt-1 block truncate font-mono text-[11px] text-(--fg-subtle)">{previewOf(step.output ?? step.input)}</span>
          )}
          <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-(--surface-muted)">
            <span className={`block h-full rounded-full ${BAR[step.status] ?? BAR.ok}`} style={{ width: `${durationPct(step, p.totalMs)}%` }} />
          </span>
        </span>
      </button>

      {p.open && !isGroup && (
        <div className="space-y-3 border-t border-(--border) px-3 pb-3 pt-3">
          {step.warnings?.length > 0 && (
            <ul className="rounded-xl border border-(--warn-border) bg-(--warn-surface) p-2 text-xs text-(--warn-fg)">
              {step.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
            </ul>
          )}
          {step.error && (
            <div className="rounded-xl border border-[rgba(244,63,94,0.4)] bg-[rgba(244,63,94,0.08)] p-2 text-xs text-(--red)">
              <span className="font-medium">{step.error.type ?? "error"}:</span> {step.error.message}
            </div>
          )}
          <JsonView value={step.input} label="Input" />
          {table && (
            <div>
              <div className="mb-1 text-xs font-medium text-(--fg-subtle)">Output — table</div>
              <Table columns={table.columns} rows={table.rows} />
            </div>
          )}
          <JsonView value={step.output} label={table ? "Output — raw" : "Output"} />
          {config && Object.keys(config).length > 0 && <JsonView value={config} label="Config" />}
          <details className="rounded-xl border border-(--border) p-2 text-xs">
            <summary className="cursor-pointer font-medium text-(--fg-muted)">Technical details</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
              <dt className="text-(--fg-subtle)">step_key</dt><dd>{step.step_key}</dd>
              <dt className="text-(--fg-subtle)">kind / name</dt><dd>{step.kind} / {step.name}</dd>
              <dt className="text-(--fg-subtle)">status</dt><dd>{step.status}</dd>
              <dt className="text-(--fg-subtle)">started_at</dt><dd>{step.started_at ?? "—"}</dd>
              <dt className="text-(--fg-subtle)">duration_ms</dt><dd>{step.duration_ms ?? "—"}</dd>
              <dt className="text-(--fg-subtle)">model</dt><dd>{step.model ?? "—"}</dd>
              <dt className="text-(--fg-subtle)">tokens in/out/cached</dt><dd>{step.tokens_input ?? "—"} / {step.tokens_output ?? "—"} / {step.tokens_cached ?? "—"}</dd>
              <dt className="text-(--fg-subtle)">cost</dt><dd>{fmtUsd(step.cost_estimate_usd)}</dd>
              <dt className="text-(--fg-subtle)">id</dt><dd>{step.id}</dd>
            </dl>
            <div className="mt-2"><JsonView value={meta} label="Metadata" /></div>
          </details>
        </div>
      )}

      {isGroup && (
        <div className="space-y-2 border-t border-(--border) p-2">
          {step.status === "warning" && step.output != null && (
            <div className="rounded-xl border border-(--warn-border) bg-(--warn-surface) p-2 text-xs text-(--warn-fg)">{previewOf(step.output, 300)}</div>
          )}
          {step.error && <div className="rounded-xl bg-[rgba(244,63,94,0.08)] p-2 text-xs text-(--red)">{step.error.message}</div>}
          {step.children.map((c) => (
            <StepCard key={c.id} {...p} step={c} depth={p.depth + 1} open={p.isOpen(c.id)} focused={p.focusedId === c.id} />
          ))}
        </div>
      )}
    </div>
  );
}
