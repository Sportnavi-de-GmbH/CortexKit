"use client";
import { useState } from "react";
import type { WorkflowConfig } from "../config/workflow.config";

export interface ConfigPanelProps {
  defaults: WorkflowConfig;
  envSet: string[];
  overrides: Partial<WorkflowConfig>;
  setOverrides: (o: Partial<WorkflowConfig>) => void;
}

type Key = keyof WorkflowConfig;
const INPUT = "w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/**
 * Every key of `defaults`, with `targetCity` prepended manually: it is optional on
 * `WorkflowConfig`, so `Object.keys(defaults)` never contains it, yet the panel must offer it.
 */
function keysOf(defaults: WorkflowConfig): Key[] {
  const rest = (Object.keys(defaults) as Key[]).filter((k) => k !== "targetCity");
  return ["targetCity", ...rest];
}

export function ConfigPanel({ defaults, envSet, overrides, setOverrides }: ConfigPanelProps) {
  const [open, setOpen] = useState(false);
  const overrideCount = Object.keys(overrides).length;

  function set(k: Key, v: unknown) {
    const next: Record<string, unknown> = { ...overrides };
    if (v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) delete next[k];
    else next[k] = v;
    setOverrides(next as Partial<WorkflowConfig>);
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* The toggle and the reset are SIBLINGS: a <button> may not contain another <button>. */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-3 text-left">
          <span className="text-zinc-400">{open ? "▼" : "▶"}</span>
          <span className="font-semibold">Configuration</span>
          <span className="text-xs text-zinc-500">
            {overrideCount > 0 ? `${overrideCount} override${overrideCount === 1 ? "" : "s"} for this run` : "defaults (env applied)"}
          </span>
        </button>
        {overrideCount > 0 && (
          <button
            type="button"
            className="ml-auto rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            onClick={() => setOverrides({})}
          >
            Reset to defaults
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="grid gap-3 md:grid-cols-3">
            {keysOf(defaults).map((k) => {
              const def = defaults[k];
              const isOverridden = k in overrides;
              const value = (overrides[k] ?? def) as unknown;
              const label = (
                <span className="mb-1 flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  <code>{k}</code>
                  {envSet.includes(k) && <span className="rounded bg-sky-100 px-1 text-[10px] text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" title="set via V3_* env">env</span>}
                  {isOverridden && <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">override</span>}
                </span>
              );
              if (k === "reranker") {
                return (
                  <label key={k} className="block">{label}
                    <input className={`${INPUT} opacity-60`} value={String(def)} readOnly />
                  </label>
                );
              }
              if (k === "targetCity") {
                return (
                  <label key={k} className="block">{label}
                    <input
                      className={INPUT}
                      type="text"
                      value={typeof overrides.targetCity === "string" ? overrides.targetCity : ""}
                      placeholder={def ? String(def) : "detect from query"}
                      onChange={(e) => set(k, e.target.value)}
                    />
                  </label>
                );
              }
              if (typeof def === "boolean") {
                return (
                  <label key={k} className="flex items-center gap-2">
                    <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(k, e.target.checked === def ? undefined : e.target.checked)} />
                    {label}
                  </label>
                );
              }
              return (
                <label key={k} className="block">{label}
                  <input
                    className={INPUT}
                    type="number"
                    step="any"
                    value={isOverridden ? String(overrides[k]) : ""}
                    placeholder={String(def)}
                    onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))}
                  />
                </label>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-zinc-500">Empty field = default (placeholder). Overrides apply to the next run only; they are sent as `config` on POST /api/workflow.</p>
        </div>
      )}
    </section>
  );
}
