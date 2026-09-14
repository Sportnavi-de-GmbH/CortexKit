// Session view: all turns of one conversation as a thread, each linking to its trace.
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSession, traceIsAbandoned } from "@/lib/monitoring/query";
import { AgentBadge, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "@/components/monitoring/ui";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession(decodeURIComponent((await params).id));
  if (!s) notFound();
  return (
    <div className="space-y-5">
      <Link href="/monitoring" className="inline-flex items-center gap-1 text-sm text-(--fg-muted) hover:text-(--fg)">
        <ArrowLeft className="h-4 w-4" /> Back to overview
      </Link>
      <header className="rounded-2xl border border-(--border) bg-(--surface) p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <AgentBadge agent={s.session.agent} />
          <span className="truncate font-mono text-xs">{s.session.id}</span>
          <span className="ml-auto text-xs text-(--fg-subtle)">
            {s.session.turn_count} turn{s.session.turn_count === 1 ? "" : "s"} · {fmtTime(s.session.first_seen_at)} → {fmtTime(s.session.last_seen_at)}
          </span>
        </div>
      </header>
      <ol className="space-y-4">
        {s.traces.map((t) => (
          <li key={t.id} className="space-y-2">
            <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-(--user-bubble) px-4 py-2 text-sm text-(--user-bubble-fg)">
              {t.user_input || <span className="opacity-60">(empty)</span>}
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-(--surface-muted) px-4 py-2 text-sm">
              <p className="whitespace-pre-wrap">{t.final_output || <span className="text-(--fg-subtle)">(no answer)</span>}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-(--fg-subtle)">
                <StatusPill status={t.status} abandoned={traceIsAbandoned(t)} />
                <span>{fmtMs(t.duration_ms)}</span>
                <span>{fmtUsd(t.cost_estimate_usd)}</span>
                <Thumb thumb={t.feedback_thumb} />
                <Link href={`/monitoring/traces/${t.id}`} className="ml-auto font-medium text-(--brand-green) hover:underline">
                  Open trace →
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
