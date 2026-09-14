import Link from "next/link";
import { traceIsAbandoned, type TraceRow } from "@/lib/monitoring/query";
import { AgentBadge, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "./ui";

const clip = (s: string | null, n = 80) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

export function TraceList({ items, nextCursor, params }: { items: TraceRow[]; nextCursor: string | null; params: URLSearchParams }) {
  const more = new URLSearchParams(params);
  if (nextCursor) more.set("cursor", nextCursor);
  return (
    <section className="rounded-2xl border border-(--border) bg-(--surface)">
      <h2 className="border-b border-(--border) px-4 py-3 font-display text-sm font-semibold">Executions</h2>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-(--fg-subtle)">No traces match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-(--fg-subtle)">
              <tr>
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-2 py-2 font-medium">Agent</th>
                <th className="px-2 py-2 font-medium">Question</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Duration</th>
                <th className="px-2 py-2 font-medium">Cost</th>
                <th className="px-2 py-2 font-medium">Steps · Tools</th>
                <th className="px-4 py-2 font-medium">Feedback</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-(--border) hover:bg-(--surface-muted)">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-(--fg-muted)">{fmtTime(t.started_at)}</td>
                  <td className="px-2 py-2"><AgentBadge agent={t.agent} /></td>
                  <td className="max-w-[360px] px-2 py-2">
                    <Link href={`/monitoring/traces/${t.id}`} title={t.user_input ?? ""} className="block truncate font-medium hover:text-(--brand-green)">
                      {clip(t.user_input) || <span className="text-(--fg-subtle)">(empty)</span>}
                    </Link>
                  </td>
                  <td className="px-2 py-2"><StatusPill status={t.status} abandoned={traceIsAbandoned(t)} /></td>
                  <td className="whitespace-nowrap px-2 py-2">{fmtMs(t.duration_ms)}</td>
                  <td className="whitespace-nowrap px-2 py-2">{fmtUsd(t.cost_estimate_usd)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-(--fg-muted)">{t.step_count} · {t.tool_call_count}</td>
                  <td className="px-4 py-2"><Thumb thumb={t.feedback_thumb} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div className="border-t border-(--border) px-4 py-3 text-center">
          <Link href={`/monitoring?${more.toString()}`} className="font-display text-sm font-medium text-(--brand-green) hover:underline">
            Load more
          </Link>
        </div>
      )}
    </section>
  );
}
