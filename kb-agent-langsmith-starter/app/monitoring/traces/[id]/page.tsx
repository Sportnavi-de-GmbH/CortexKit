// Trace detail: header card · conversation frame · errors · step timeline ·
// sticky right rail. Server component; the timeline is the client island.
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTrace, traceIsAbandoned } from "@/lib/monitoring/query";
import { Timeline } from "@/components/monitoring/Timeline";
import { TraceSidebar } from "@/components/monitoring/TraceSidebar";
import { AgentBadge, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "@/components/monitoring/ui";

export const dynamic = "force-dynamic";

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTrace(id);
  if (!t) notFound();
  const { trace, steps, errors, feedback, prompt } = t;
  return (
    <div className="space-y-5">
      <Link href="/monitoring" className="inline-flex items-center gap-1 text-sm text-(--fg-muted) hover:text-(--fg)">
        <ArrowLeft className="h-4 w-4" /> Back to overview
      </Link>
      <header className="rounded-2xl border border-(--border) bg-(--surface) p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <AgentBadge agent={trace.agent} />
          <StatusPill status={trace.status} abandoned={traceIsAbandoned(trace)} />
          <span>{fmtMs(trace.duration_ms)}</span>
          <span>· {trace.step_count} steps</span>
          <span>· {trace.tool_call_count} tool calls</span>
          <span>· {fmtUsd(trace.cost_estimate_usd)}</span>
          <Thumb thumb={trace.feedback_thumb} />
          <span className="ml-auto text-xs text-(--fg-subtle)">
            {fmtTime(trace.started_at)} · {trace.turn_id}
          </span>
        </div>
      </header>
      {/* grid-cols-1 = minmax(0,1fr): without it the implicit auto track takes the cards' min-content width (measured 917 px at a 400 px viewport). */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <section className="rounded-2xl border border-(--border) bg-(--surface) p-4">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-(--fg-subtle)">What the user asked</h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{trace.user_input}</p>
            <h2 className="mt-4 font-display text-xs font-semibold uppercase tracking-wide text-(--fg-subtle)">What Navio answered</h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {trace.final_output || <span className="text-(--fg-subtle)">(no answer)</span>}
            </p>
          </section>
          {errors.length > 0 && (
            <section className="rounded-2xl border border-[rgba(244,63,94,0.4)] bg-(--surface) p-4">
              <h2 className="font-display text-sm font-semibold text-(--red)">Errors &amp; warnings</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {errors.map((e) => (
                  <li key={e.id} className={e.level === "error" ? "text-(--red)" : "text-(--warn-fg)"}>
                    <span className="font-mono text-xs">
                      {e.level} · {e.type}
                    </span>{" "}
                    — {e.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Timeline steps={steps} totalMs={trace.duration_ms ?? 0} />
        </div>
        <TraceSidebar trace={trace} prompt={prompt} feedback={feedback} />
      </div>
    </div>
  );
}
