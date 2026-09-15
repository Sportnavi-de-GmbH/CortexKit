// Trace detail: breadcrumb + title · summary strip · conversation · errors ·
// step timeline · sticky right rail. Server component; the timeline is the
// client island.
import { notFound } from "next/navigation";
import { AlertTriangle, Clock, DollarSign, ListOrdered, Wrench } from "lucide-react";
import { getTrace, traceIsAbandoned } from "@/lib/monitoring/query";
import { AnswerBox } from "@/components/monitoring/AnswerBox";
import { PageHeader } from "@/components/monitoring/PageHeader";
import { Timeline } from "@/components/monitoring/Timeline";
import { TraceSidebar } from "@/components/monitoring/TraceSidebar";
import { AgentBadge, Card, Kicker, Stat, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "@/components/monitoring/ui";

export const dynamic = "force-dynamic";

const clip = (s: string | null, n = 90) => (!s ? "(empty message)" : s.length > n ? `${s.slice(0, n)}…` : s);

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTrace(id);
  if (!t) notFound();
  const { trace, steps, errors, feedback, prompt } = t;
  const agentName = trace.agent === "faq" ? "FAQ agent" : "Partner agent";

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Overview", href: "/monitoring" }, { label: `${agentName} · ${trace.turn_id}` }]}
        title={clip(trace.user_input)}
        description={`${agentName} · ${fmtTime(trace.started_at)}`}
        actions={
          <>
            <AgentBadge agent={trace.agent} size="md" />
            <StatusPill status={trace.status} abandoned={traceIsAbandoned(trace)} size="md" />
          </>
        }
      />

      <Card bodyClassName="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-5">
        <Stat icon={<Clock className="h-4 w-4" />} label="Duration" value={fmtMs(trace.duration_ms)} />
        <Stat icon={<ListOrdered className="h-4 w-4" />} label="Steps" value={trace.step_count} />
        <Stat icon={<Wrench className="h-4 w-4" />} label="Tool calls" value={trace.tool_call_count} />
        <Stat icon={<DollarSign className="h-4 w-4" />} label="Cost" value={fmtUsd(trace.cost_estimate_usd)} />
        <Stat icon={<Thumb thumb={trace.feedback_thumb} className="h-4 w-4" />} label="Feedback" value={trace.feedback_thumb === "up" ? "Positive" : trace.feedback_thumb === "down" ? "Negative" : "Not rated"} />
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Card title="Conversation" kicker="What was asked and answered" bodyClassName="space-y-4 p-5">
            <div>
              <Kicker className="mb-1.5">Visitor asked</Kicker>
              <div className="inline-block max-w-full rounded-2xl rounded-tl-sm bg-(--user-bubble) px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-(--user-bubble-fg)">
                {trace.user_input || <span className="opacity-60">(empty message)</span>}
              </div>
            </div>
            <div>
              <Kicker className="mb-1.5">Navio answered</Kicker>
              <div className="rounded-2xl rounded-tl-sm bg-(--surface-muted) px-4 py-3">
                {trace.final_output ? <AnswerBox text={trace.final_output} /> : <span className="text-sm text-(--fg-subtle)">(no answer was produced)</span>}
              </div>
            </div>
          </Card>

          {errors.length > 0 && (
            <Card
              title="Errors & warnings"
              kicker={`${errors.filter((e) => e.level === "error").length} error · ${errors.filter((e) => e.level === "warning").length} warning`}
              className="border-(--red)/40"
              bodyClassName="p-2"
            >
              <ul className="divide-y divide-(--border)">
                {errors.map((e) => (
                  <li key={e.id} className="flex gap-3 px-3 py-2.5 text-sm">
                    <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${e.level === "error" ? "text-(--red)" : "text-(--warn-icon)"}`} aria-hidden />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={`rounded-md px-1.5 py-0.5 font-semibold uppercase tracking-wide ${e.level === "error" ? "bg-(--red)/12 text-(--red)" : "bg-(--warn-surface) text-(--warn-fg)"}`}>{e.level}</span>
                        <span className="font-mono text-(--fg-muted)">{e.type}</span>
                      </div>
                      <p className="mt-1 break-words text-[13px] leading-snug text-(--fg)">{e.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Timeline steps={steps} totalMs={trace.duration_ms ?? 0} />
        </div>
        <TraceSidebar trace={trace} prompt={prompt} feedback={feedback} />
      </div>
    </div>
  );
}
