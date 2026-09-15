// The executions table. Whole row is the link (stretched anchor), numbers are
// right-aligned and tabular, the header sticks inside the scroll container,
// and the table scrolls horizontally on its own below ~880 px (the page never does).
import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";
import { traceIsAbandoned, type TraceRow } from "@/lib/monitoring/query";
import { AgentBadge, Card, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "./ui";

const clip = (s: string | null, n = 90) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

export function TraceList({ items, nextCursor, params }: { items: TraceRow[]; nextCursor: string | null; params: URLSearchParams }) {
  const more = new URLSearchParams(params);
  if (nextCursor) more.set("cursor", nextCursor);
  return (
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
                <th scope="col" className="px-5 py-2.5 font-semibold">Time</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Agent</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Question</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Duration</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Cost</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Steps · Tools</th>
                <th scope="col" className="px-3 py-2.5 text-center font-semibold">Feedback</th>
                <th scope="col" className="w-10 px-3 py-2.5"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="group relative border-t border-(--border) transition-colors duration-150 hover:bg-(--surface-muted)/60">
                  <td className="whitespace-nowrap px-5 py-3 text-xs tabular text-(--fg-muted)">{fmtTime(t.started_at)}</td>
                  <td className="px-3 py-3"><AgentBadge agent={t.agent} /></td>
                  <td className="max-w-[420px] px-3 py-3">
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
                  <td className="px-3 py-3 text-right">
                    <ArrowRight className="ml-auto h-4 w-4 text-(--fg-subtle) transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-(--fg)" aria-hidden />
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
  );
}
