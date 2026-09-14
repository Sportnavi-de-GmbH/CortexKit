"use client";

// Plain GET form: submitting reloads /monitoring?… and the server re-renders.
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

const select = "rounded-xl border border-(--border) bg-(--surface-muted) px-2 py-1.5 text-sm outline-none focus:border-(--brand-green)";

export function TraceFilters() {
  const sp = useSearchParams();
  const v = (k: string) => sp.get(k) ?? "";
  return (
    <form method="get" action="/monitoring" className="flex flex-wrap items-end gap-2 rounded-2xl border border-(--border) bg-(--surface) p-3">
      <label className="flex flex-col gap-1 text-xs text-(--fg-subtle)">
        Range
        <select name="range" defaultValue={v("range") || "24h"} className={select}>
          <option value="24h">Last 24 h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-(--fg-subtle)">
        Agent
        <select name="agent" defaultValue={v("agent")} className={select}>
          <option value="">All</option>
          <option value="faq">FAQ</option>
          <option value="partner">Partner</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-(--fg-subtle)">
        Status
        <select name="status" defaultValue={v("status")} className={select}>
          <option value="">All</option>
          <option value="completed">Completed</option>
          <option value="needs_clarification">Needs clarification</option>
          <option value="partial">Partial</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-(--fg-subtle)">
        Feedback
        <select name="thumb" defaultValue={v("thumb")} className={select}>
          <option value="">All</option>
          <option value="up">👍</option>
          <option value="down">👎</option>
          <option value="none">Not rated</option>
        </select>
      </label>
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-(--fg-subtle)">
        Search
        <input name="q" defaultValue={v("q")} placeholder="Question or answer…" className={select} />
      </label>
      <button className="inline-flex items-center gap-1 rounded-full bg-(--brand-green) px-4 py-2 font-display text-sm font-semibold text-white">
        <Search className="h-4 w-4" /> Filter
      </button>
    </form>
  );
}
