"use client";

// The step timeline: numbered vertical rail, one card per step, V3 task groups
// as side-by-side lanes. Steps collapsed by default. Keyboard: j/k move,
// Enter/Space toggle, e expand all, c collapse all.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, GitFork } from "lucide-react";
import type { StepNode } from "@/lib/monitoring/query";
import { StepCard } from "./StepCard";
import { allIds, laneLayout, visibleOrder } from "./timeline-model";
import { BTN_SECONDARY } from "./ui";

function Key({ children }: { children: string }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-(--border) bg-(--surface) px-1 font-mono text-[10.5px] text-(--fg-muted)">{children}</kbd>;
}

export function Timeline({ steps, totalMs }: { steps: StepNode[]; totalMs: number }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<number>(0);
  const order = useMemo(() => visibleOrder(steps, open), [steps, open]);
  const focusedId = order[focus] ?? null;
  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expandAll = () => setOpen(new Set(allIds(steps)));
  const collapseAll = () => setOpen(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "j") { setFocus((f) => Math.min(order.length - 1, f + 1)); e.preventDefault(); }
      else if (e.key === "k") { setFocus((f) => Math.max(0, f - 1)); e.preventDefault(); }
      else if (e.key === "e") expandAll();
      else if (e.key === "c") collapseAll();
      else if ((e.key === "Enter" || e.key === " ") && focusedId) { toggle(focusedId); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, focusedId, toggle]);

  useEffect(() => {
    if (focusedId) document.getElementById(`step-${focusedId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

  const rows = laneLayout(steps);
  const cardProps = { totalMs, onToggle: toggle, isOpen: (id: string) => open.has(id), focusedId };
  let n = 0;

  return (
    <section aria-labelledby="timeline-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="timeline-title" className="font-display text-[15px] font-semibold text-(--fg)">Timeline</h2>
          <p className="text-xs text-(--fg-muted)">{steps.length} top-level step{steps.length === 1 ? "" : "s"} · click a step for its input and output</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1 text-[11px] text-(--fg-subtle) lg:inline-flex">
            <Key>j</Key><Key>k</Key> move · <Key>e</Key> expand · <Key>c</Key> collapse
          </span>
          <button type="button" onClick={expandAll} className={BTN_SECONDARY}><ChevronsUpDown className="h-3.5 w-3.5" aria-hidden /> Expand all</button>
          <button type="button" onClick={collapseAll} className={BTN_SECONDARY}><ChevronsDownUp className="h-3.5 w-3.5" aria-hidden /> Collapse all</button>
        </div>
      </div>
      <ol className="relative space-y-4 pl-9 before:absolute before:top-4 before:bottom-4 before:left-[15px] before:w-px before:bg-(--border-strong)">
        {rows.map((row, i) => {
          n += 1;
          const marker = (
            <span
              className={`absolute top-3.5 left-0 flex h-[30px] w-[30px] items-center justify-center rounded-full border-2 border-(--surface) font-display text-[11px] font-semibold ${
                row.kind === "lanes" ? "bg-(--brand-orange) text-(--ink)" : "bg-(--brand-green) text-(--ink)"
              }`}
              aria-hidden
            >
              {row.kind === "lanes" ? <GitFork className="h-3.5 w-3.5" /> : n}
            </span>
          );
          return row.kind === "step" ? (
            <li key={row.step.id} className="relative -ml-9 pl-9">
              {marker}
              <StepCard {...cardProps} step={row.step} depth={0} open={open.has(row.step.id)} focused={focusedId === row.step.id} />
            </li>
          ) : (
            <li key={`lanes-${i}`} className="relative -ml-9 pl-9">
              {marker}
              <div className="mb-2 flex items-center gap-2 pt-2 text-xs font-medium text-(--fg-muted)">
                {row.groups.length > 1 ? `${row.groups.length} tasks ran in parallel` : "1 task"}
              </div>
              <div className={`grid grid-cols-1 gap-3 ${row.groups.length > 1 ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}>
                {row.groups.map((g) => (
                  <StepCard key={g.id} {...cardProps} step={g} depth={0} open={true} focused={focusedId === g.id} />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
