"use client";

// Plain GET form: submitting reloads /monitoring?… and the server re-renders.
// Range is a segmented control (three options, one click); the rest are
// labelled selects with a consistent 40 px height. "Reset" appears only when a
// filter is active.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, Search, X } from "lucide-react";
import { BTN_PRIMARY, CARD, INPUT, SELECT } from "./ui";

const RANGES = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

function Select({ name, label, value, children }: { name: string; label: string; value: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-medium text-(--fg-muted) sm:flex-none">
      {label}
      <span className="relative">
        <select name={name} defaultValue={value} className={SELECT}>
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-(--fg-subtle)" aria-hidden />
      </span>
    </label>
  );
}

export function TraceFilters() {
  const sp = useSearchParams();
  const v = (k: string) => sp.get(k) ?? "";
  const range = v("range") || "24h";
  const active = ["agent", "status", "thumb", "q"].filter((k) => v(k)).length;

  return (
    <form method="get" action="/monitoring" className={`${CARD} flex flex-wrap items-end gap-3 p-4`} role="search" aria-label="Filter executions">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-(--fg-muted)">Range</legend>
        <div className="flex h-10 rounded-full border border-(--border) bg-(--surface-muted) p-0.5" role="radiogroup">
          {RANGES.map((r) => (
            <label key={r.value} className="relative">
              <input type="radio" name="range" value={r.value} defaultChecked={range === r.value} className="peer sr-only" />
              <span className="flex h-full cursor-pointer items-center rounded-full px-3.5 font-display text-[13px] font-medium text-(--fg-muted) transition-colors peer-checked:bg-(--surface) peer-checked:text-(--fg) peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-(--accent) hover:text-(--fg)">
                {r.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Select name="agent" label="Agent" value={v("agent")}>
        <option value="">All agents</option>
        <option value="faq">FAQ</option>
        <option value="partner">Partner</option>
      </Select>
      <Select name="status" label="Status" value={v("status")}>
        <option value="">Any status</option>
        <option value="completed">Completed</option>
        <option value="needs_clarification">Needs clarification</option>
        <option value="partial">Partial</option>
        <option value="failed">Failed</option>
        <option value="running">Running</option>
      </Select>
      <Select name="thumb" label="Feedback" value={v("thumb")}>
        <option value="">Any feedback</option>
        <option value="up">Thumbs up</option>
        <option value="down">Thumbs down</option>
        <option value="none">Not rated</option>
      </Select>

      <label className="flex min-w-[12rem] flex-[2] flex-col gap-1 text-xs font-medium text-(--fg-muted)">
        Search
        <span className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-(--fg-subtle)" aria-hidden />
          <input name="q" defaultValue={v("q")} placeholder="Question or answer text…" className={`${INPUT} pl-9`} />
        </span>
      </label>

      <div className="flex items-center gap-2">
        <button className={BTN_PRIMARY}>Apply</button>
        {active > 0 && (
          <Link href={`/monitoring?range=${range}`} className="inline-flex h-10 items-center gap-1 rounded-full px-3 text-sm text-(--fg-muted) transition-colors hover:bg-(--surface-muted) hover:text-(--fg)">
            <X className="h-3.5 w-3.5" /> Reset{active > 1 ? ` (${active})` : ""}
          </Link>
        )}
      </div>
    </form>
  );
}
