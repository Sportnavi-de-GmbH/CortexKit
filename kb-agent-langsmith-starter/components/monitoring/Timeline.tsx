"use client";

// The step timeline: vertical rail, one card per step, V3 task groups as
// side-by-side lanes. Steps collapsed by default. Keyboard: j/k move,
// Enter/Space toggle, e expand all, c collapse all.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StepNode } from "@/lib/monitoring/query";
import { StepCard } from "./StepCard";
import { allIds, laneLayout, visibleOrder } from "./timeline-model";

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

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-sm font-semibold">Timeline</h2>
        <div className="flex items-center gap-2 text-xs text-(--fg-muted)">
          <span className="hidden sm:inline">
            <kbd className="rounded border border-(--border) px-1">j</kbd> <kbd className="rounded border border-(--border) px-1">k</kbd> move ·{" "}
            <kbd className="rounded border border-(--border) px-1">e</kbd> expand · <kbd className="rounded border border-(--border) px-1">c</kbd> collapse
          </span>
          <button type="button" onClick={expandAll} className="rounded-full border border-(--border) px-2 py-0.5 hover:bg-(--surface-muted)">Expand all</button>
          <button type="button" onClick={collapseAll} className="rounded-full border border-(--border) px-2 py-0.5 hover:bg-(--surface-muted)">Collapse all</button>
        </div>
      </div>
      <ol className="space-y-3 border-l-2 border-(--border) pl-4">
        {rows.map((row, i) =>
          row.kind === "step" ? (
            <li key={row.step.id} className="relative">
              <span className="absolute -left-[23px] top-4 h-3 w-3 rounded-full border-2 border-(--surface) bg-(--brand-green)" />
              <StepCard {...cardProps} step={row.step} depth={0} open={open.has(row.step.id)} focused={focusedId === row.step.id} />
            </li>
          ) : (
            <li key={`lanes-${i}`} className="relative">
              <span className="absolute -left-[23px] top-4 h-3 w-3 rounded-full border-2 border-(--surface) bg-(--brand-orange)" />
              <div className="mb-1 text-xs text-(--fg-subtle)">{row.groups.length} task{row.groups.length > 1 ? "s ran in parallel" : ""}</div>
              <div className={`grid grid-cols-1 gap-3 ${row.groups.length > 1 ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}>
                {row.groups.map((g) => (
                  <StepCard key={g.id} {...cardProps} step={g} depth={0} open={true} focused={focusedId === g.id} />
                ))}
              </div>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
