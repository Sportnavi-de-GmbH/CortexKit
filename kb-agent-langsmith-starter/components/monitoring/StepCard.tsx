"use client";

// One step of the timeline: plain-language header, proportional duration bar,
// and — when open — Input / Output (table view where the data is a list),
// Config, Warnings, Error, and a Technical details disclosure.
import { AlertTriangle, ChevronRight, Database, Layers, MessageSquare, Send, Shuffle, Sparkles, Wrench } from "lucide-react";
import type { StepNode } from "@/lib/monitoring/query";
import type { StepKind } from "@/lib/monitoring/types";
import { JsonView } from "./JsonView";
import { KIND_LABEL, durationPct, previewOf, tableFor } from "./timeline-model";
import { Kicker, StatusPill, fmtMs, fmtUsd } from "./ui";

const ICON: Record<StepKind, typeof Sparkles> = {
  request: MessageSquare, llm: Sparkles, tool: Wrench, retrieval: Database, transform: Shuffle, response: Send, error: AlertTriangle, group: Layers,
};

/** Icon tile tint by kind: model calls green (AI), tools orange (external work), errors red, rest neutral. */
const ICON_TONE: Record<StepKind, string> = {
  llm: "bg-(--accent-dim) text-(--fg)",
  tool: "bg-(--warn-surface) text-(--warn-icon)",
  error: "bg-(--red)/12 text-(--red)",
  request: "bg-(--surface-muted) text-(--fg-muted)",
  retrieval: "bg-(--surface-muted) text-(--fg-muted)",
  transform: "bg-(--surface-muted) text-(--fg-muted)",
  response: "bg-(--surface-muted) text-(--fg-muted)",
  group: "bg-(--surface-muted) text-(--fg-muted)",
};

const BAR: Record<string, string> = {
  ok: "bg-(--brand-green)", warning: "bg-(--brand-orange)", error: "bg-(--red)", skipped: "bg-(--border-strong)",
};

function Table({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const cell = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : v === null || v === undefined ? "" : String(v));
  return (
    <div className="overflow-x-auto rounded-xl border border-(--border)">
      <table className="w-full text-xs">
        <thead className="bg-(--surface-muted) text-left text-[11px] uppercase tracking-wide text-(--fg-subtle)">
          <tr>{columns.map((c) => <th key={c} className="px-2.5 py-1.5 font-semibold">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r, i) => (
            <tr key={i} className="border-t border-(--border)">{columns.map((c) => <td key={c} className="whitespace-nowrap px-2.5 py-1.5 tabular">{cell(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && <div className="px-2.5 py-1.5 text-[11px] text-(--fg-subtle)">Showing 50 of {rows.length} — the raw JSON below has all rows.</div>}
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
  const preview = !p.open && !isGroup ? previewOf(step.output ?? step.input) : "";
  const hasIssue = step.status === "error" || step.status === "warning";

  return (
    <div
      id={`step-${step.id}`}
      className={`rounded-2xl border bg-(--surface) transition-[border-color,box-shadow] duration-200 ${
        p.focused ? "border-(--brand-green) ring-2 ring-(--brand-green)/25" : hasIssue ? (step.status === "error" ? "border-(--red)/40" : "border-(--warn-border)") : "border-(--border)"
      } ${p.depth > 0 ? "" : "soft-shadow"}`}
    >
      <button
        type="button"
        onClick={() => p.onToggle(step.id)}
        className="flex w-full items-start gap-3 rounded-2xl p-3.5 text-left transition-colors duration-150 hover:bg-(--surface-muted)/50"
        aria-expanded={isGroup ? undefined : p.open}
        aria-controls={isGroup ? undefined : `step-body-${step.id}`}
      >
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${ICON_TONE[step.kind]}`} aria-hidden>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-[14px] font-semibold leading-tight text-(--fg)">{step.title}</span>
            <span className="rounded-md bg-(--surface-muted) px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-(--fg-subtle)">{KIND_LABEL[step.kind]}</span>
            {step.tool_name && <span className="rounded-md border border-(--border) px-1.5 py-0.5 font-mono text-[11px] text-(--fg-muted)">{step.tool_name}</span>}
            <span className="ml-auto flex items-center gap-2 text-xs tabular text-(--fg-muted)">
              {fmtMs(step.duration_ms)}
              <StatusPill status={step.status} />
              {!isGroup && <ChevronRight className={`h-4 w-4 text-(--fg-subtle) transition-transform duration-200 ${p.open ? "rotate-90" : ""}`} aria-hidden />}
            </span>
          </span>
          <span className="mt-1 block text-[12.5px] leading-snug text-(--fg-muted)">{step.purpose}</span>
          {preview && <span className="mt-1.5 block truncate font-mono text-[11px] text-(--fg-subtle)">{preview}</span>}
          <span className="mt-2.5 block h-1 w-full overflow-hidden rounded-full bg-(--surface-muted)">
            <span className={`block h-full rounded-full ${BAR[step.status] ?? BAR.ok}`} style={{ width: `${durationPct(step, p.totalMs)}%` }} />
          </span>
        </span>
      </button>

      {p.open && !isGroup && (
        <div id={`step-body-${step.id}`} className="space-y-4 border-t border-(--border) px-3.5 pb-4 pt-4">
          {step.warnings?.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-(--warn-border) bg-(--warn-surface) px-3 py-2 text-xs text-(--warn-fg)">
              {step.warnings.map((w, i) => (
                <li key={i} className="flex gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--warn-icon)" aria-hidden />{w}</li>
              ))}
            </ul>
          )}
          {step.error && (
            <div className="flex gap-2 rounded-xl border border-(--red)/40 bg-(--red)/8 px-3 py-2 text-xs text-(--red)">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span><span className="font-semibold">{step.error.type ?? "error"}:</span> {step.error.message}</span>
            </div>
          )}
          <JsonView value={step.input} label="Input" />
          {table && (
            <div>
              <Kicker className="mb-1.5">Output · table</Kicker>
              <Table columns={table.columns} rows={table.rows} />
            </div>
          )}
          <JsonView value={step.output} label={table ? "Output · raw" : "Output"} />
          {config && Object.keys(config).length > 0 && <JsonView value={config} label="Config" />}
          <details className="rounded-xl border border-(--border)">
            <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-medium text-(--fg-muted) transition-colors hover:text-(--fg)">
              <ChevronRight className="mon-chevron h-3.5 w-3.5 transition-transform duration-200" aria-hidden /> Technical details
            </summary>
            <div className="space-y-3 border-t border-(--border) px-3 pb-3 pt-2">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
                <dt className="text-(--fg-subtle)">step_key</dt><dd className="break-all">{step.step_key}</dd>
                <dt className="text-(--fg-subtle)">kind / name</dt><dd>{step.kind} / {step.name}</dd>
                <dt className="text-(--fg-subtle)">status</dt><dd>{step.status}</dd>
                <dt className="text-(--fg-subtle)">started_at</dt><dd>{step.started_at ?? "—"}</dd>
                <dt className="text-(--fg-subtle)">duration_ms</dt><dd>{step.duration_ms ?? "—"}</dd>
                <dt className="text-(--fg-subtle)">model</dt><dd>{step.model ?? "—"}</dd>
                <dt className="text-(--fg-subtle)">tokens in / out / cached</dt><dd>{step.tokens_input ?? "—"} / {step.tokens_output ?? "—"} / {step.tokens_cached ?? "—"}</dd>
                <dt className="text-(--fg-subtle)">cost</dt><dd>{fmtUsd(step.cost_estimate_usd)}</dd>
                <dt className="text-(--fg-subtle)">id</dt><dd className="break-all">{step.id}</dd>
              </dl>
              <JsonView value={meta} label="Metadata" />
            </div>
          </details>
        </div>
      )}

      {isGroup && (
        <div className="space-y-2 border-t border-(--border) p-2.5">
          {step.status === "warning" && step.output != null && (
            <div className="rounded-xl border border-(--warn-border) bg-(--warn-surface) px-3 py-2 text-xs text-(--warn-fg)">{previewOf(step.output, 300)}</div>
          )}
          {step.error && <div className="rounded-xl bg-(--red)/8 px-3 py-2 text-xs text-(--red)">{step.error.message}</div>}
          {step.children.map((c) => (
            <StepCard key={c.id} {...p} step={c} depth={p.depth + 1} open={p.isOpen(c.id)} focused={p.focusedId === c.id} />
          ))}
        </div>
      )}
    </div>
  );
}
