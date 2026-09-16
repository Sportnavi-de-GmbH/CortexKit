// Session view: all turns of one conversation as a thread, each linking to its trace.
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getSession, traceIsAbandoned } from "@/lib/monitoring/query";
import { AnswerBox } from "@/components/monitoring/AnswerBox";
import { DeleteTraceButton } from "@/components/monitoring/DeleteTraceButton";
import { PageHeader } from "@/components/monitoring/PageHeader";
import { AgentBadge, Card, KV, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "@/components/monitoring/ui";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession(decodeURIComponent((await params).id));
  if (!s) notFound();
  const agentName = s.session.agent === "faq" ? "FAQ agent" : "Partner agent";
  const turns = s.traces.length;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Overview", href: "/monitoring" }, { label: "Conversation" }]}
        title={`${turns} turn${turns === 1 ? "" : "s"} with the ${agentName}`}
        description={`${fmtTime(s.session.first_seen_at)} → ${fmtTime(s.session.last_seen_at)}`}
        actions={<AgentBadge agent={s.session.agent} size="md" />}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ol className="min-w-0 space-y-6" aria-label="Conversation turns">
          {s.traces.map((t, i) => (
            <li key={t.id} className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-(--fg-subtle)">
                <span className="font-display font-semibold uppercase tracking-[0.08em]">Turn {i + 1}</span>
                <span className="tabular">{fmtTime(t.started_at)}</span>
              </div>
              <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-tr-sm bg-(--user-bubble) px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-(--user-bubble-fg)">
                {t.user_input || <span className="opacity-60">(empty message)</span>}
              </div>
              <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-(--border) bg-(--surface) px-4 py-3">
                {t.final_output ? <AnswerBox text={t.final_output} fade="surface" /> :<span className="text-sm text-(--fg-subtle)">(no answer was produced)</span>}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--border) pt-2.5 text-xs text-(--fg-muted)">
                  <StatusPill status={t.status} abandoned={traceIsAbandoned(t)} />
                  <span className="tabular">{fmtMs(t.duration_ms)}</span>
                  <span className="tabular">{fmtUsd(t.cost_estimate_usd)}</span>
                  <Thumb thumb={t.feedback_thumb} />
                  <Link
                    href={`/monitoring/traces/${t.id}`}
                    className="ml-auto inline-flex h-8 items-center gap-1 rounded-full border border-(--border) px-3 font-display font-medium text-(--fg) transition-colors duration-150 hover:bg-(--surface-muted)"
                  >
                    Open trace <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                  {/* Deleting the last turn also deletes the session, so refreshing this route would 404. */}
                  <DeleteTraceButton id={t.id} size="sm" afterDelete={turns === 1 ? "overview" : "refresh"} />
                </div>
              </div>
            </li>
          ))}
        </ol>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Session details">
          <Card title="Session" bodyClassName="px-5 py-3">
            <dl>
              <KV k="Agent" v={agentName} />
              <KV k="Turns" v={s.session.turn_count} />
              <KV k="First seen" v={fmtTime(s.session.first_seen_at)} />
              <KV k="Last seen" v={fmtTime(s.session.last_seen_at)} />
              {s.session.origin && <KV k="Origin" v={s.session.origin} mono />}
            </dl>
            <div className="mt-2 break-all rounded-xl bg-(--surface-muted) px-3 py-2 font-mono text-[11px] text-(--fg-muted)">{s.session.id}</div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
