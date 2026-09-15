"use client";

// The executions table. Whole row is the link (stretched anchor), numbers are
// right-aligned and tabular, the header sticks inside the scroll container,
// and the table scrolls horizontally on its own below ~880 px (the page never does).
// Client component since 2026-09-15: a checkbox column (first) and a trash
// column (last) feed the shared DeleteBar / ConfirmDialog flow (spec §5).
// `params` is the query STRING — a URLSearchParams instance cannot cross the
// server→client boundary (same fix as AlertFeed).
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Inbox, Trash2 } from "lucide-react";
import type { TraceRow } from "@/lib/monitoring/query";
import { DeleteBar } from "./DeleteBar";
import { traceIsAbandoned } from "./format";
import { allSelected, clearAll, selectAll, toggle } from "./selection";
import { AgentBadge, Card, ICON_BTN, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "./ui";
import { useDeleteFlow } from "./useDeleteFlow";

const clip = (s: string | null, n = 90) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

export function TraceList({ items, nextCursor, params }: { items: TraceRow[]; nextCursor: string | null; params: string }) {
  const more = new URLSearchParams(params);
  if (nextCursor) more.set("cursor", nextCursor);

  const [selected, setSelected] = useState<Set<string>>(() => clearAll());
  const ids = items.map((t) => t.id);
  const all = allSelected(selected, ids);
  const some = selected.size > 0 && !all;

  // When the rows change (filter, refresh after a delete), drop ids that are no longer shown.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(ids);
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join("|")]);

  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = some;
  }, [some]);

  const del = useDeleteFlow({ endpoint: "/api/monitoring/traces", kind: "trace", onDone: () => setSelected(clearAll()) });
  const barVisible = selected.size > 0;

  return (
    // Bottom padding while the sticky bar is shown, so it never covers the last rows.
    <div className={barVisible ? "pb-24" : ""}>
      <Card
        title="Executions"
        kicker="Newest first"
        actions={<span className="text-xs text-(--fg-muted)">{items.length} shown{nextCursor ? " · more available" : ""}</span>}
        bodyClassName="p-0"
      >
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Inbox className="h-6 w-6 text-(--fg-subtle)" aria-hidden />
            <p className="text-sm text-(--fg-muted)">No executions match these filters.</p>
            <Link href="/monitoring" className="text-sm font-medium text-(--fg) underline decoration-(--brand-green) decoration-2 underline-offset-[3px]">
              Clear filters
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="mon-table w-full min-w-[880px] border-collapse text-sm">
              <caption className="sr-only">Agent executions, newest first</caption>
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-(--fg-subtle)">
                  <th scope="col" className="w-10 py-2.5 pl-5 pr-1">
                    <input
                      ref={headerBox}
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-(--brand-green)"
                      aria-label="Alle angezeigten Ausführungen auswählen"
                      checked={all}
                      onChange={() => setSelected(all ? clearAll() : selectAll(selected, ids))}
                    />
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Time</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Agent</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Question</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Duration</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Cost</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Steps · Tools</th>
                  <th scope="col" className="px-3 py-2.5 text-center font-semibold">Feedback</th>
                  <th scope="col" className="w-8 py-2.5 pl-2 pr-0"><span className="sr-only">Open</span></th>
                  <th scope="col" className="w-11 py-2.5 pl-0 pr-2"><span className="sr-only">Löschen</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr
                    key={t.id}
                    className={`group relative border-t border-(--border) transition-colors duration-150 hover:bg-(--surface-muted)/60 ${selected.has(t.id) ? "bg-(--accent-dim)/60" : ""}`}
                  >
                    <td className="relative z-10 py-3 pl-5 pr-1">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-(--brand-green)"
                        aria-label="Ausführung auswählen"
                        checked={selected.has(t.id)}
                        onChange={() => setSelected(toggle(selected, t.id))}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs tabular text-(--fg-muted)">{fmtTime(t.started_at)}</td>
                    <td className="px-3 py-3"><AgentBadge agent={t.agent} /></td>
                    <td className="max-w-[400px] px-3 py-3">
                      <Link
                        href={`/monitoring/traces/${t.id}`}
                        title={t.user_input ?? ""}
                        className="block truncate font-medium text-(--fg) after:absolute after:inset-0 after:content-[''] group-hover:text-(--fg)"
                      >
                        {clip(t.user_input) || <span className="text-(--fg-subtle)">(empty message)</span>}
                      </Link>
                    </td>
                    <td className="px-3 py-3"><StatusPill status={t.status} abandoned={traceIsAbandoned(t)} /></td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular">{fmtMs(t.duration_ms)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular">{fmtUsd(t.cost_estimate_usd)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular text-(--fg-muted)">
                      {t.step_count} <span className="text-(--fg-subtle)">·</span> {t.tool_call_count}
                    </td>
                    <td className="px-3 py-3 text-center"><span className="inline-flex justify-center"><Thumb thumb={t.feedback_thumb} /></span></td>
                    <td className="py-3 pl-2 pr-0 text-right">
                      <ArrowRight className="ml-auto h-4 w-4 text-(--fg-subtle) transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-(--fg)" aria-hidden />
                    </td>
                    <td className="relative z-10 py-2 pl-0 pr-2 text-right">
                      <button
                        type="button"
                        className={`${ICON_BTN} hover:text-(--red)`}
                        aria-label="Ausführung löschen"
                        title="Ausführung löschen"
                        disabled={del.busy}
                        onClick={() => del.confirm([t.id])}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div className="border-t border-(--border) px-5 py-3 text-center">
            <Link href={`/monitoring?${more.toString()}`} className="inline-flex h-9 items-center rounded-full border border-(--border) px-4 font-display text-sm font-medium text-(--fg) transition-colors hover:bg-(--surface-muted)">
              Load older executions
            </Link>
          </div>
        )}
      </Card>
      <DeleteBar count={selected.size} busy={del.busy} onClear={() => setSelected(clearAll())} onDelete={() => del.confirm([...selected])} />
      {del.dialog}
    </div>
  );
}
