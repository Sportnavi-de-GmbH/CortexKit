// Sticky right rail of the trace detail: prompt version, models & cost,
// session, feedback history, build version. Server component; the prompt
// dialog is the only client island.
import Link from "next/link";
import { ArrowUpRight, MessageSquareText } from "lucide-react";
import type { FeedbackRow, PromptRow, TraceRow } from "@/lib/monitoring/query";
import { PromptDialog } from "./PromptDialog";
import { Card, KV, Thumb, fmtInt, fmtTime, fmtUsd } from "./ui";

export function TraceSidebar({ trace, prompt, feedback }: { trace: TraceRow; prompt: PromptRow | null; feedback: FeedbackRow[] }) {
  const meta = trace.metadata ?? {};
  const langfuse = typeof meta.langfuse_session_id === "string" ? meta.langfuse_session_id : null;
  const body = "px-5 py-3";
  return (
    <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Trace context">
      {trace.agent === "faq" && (
        <Card title="Knowledge base" kicker="Prompt version" bodyClassName={body}>
          {prompt ? (
            <dl>
              <KV k="Fingerprint" v={prompt.sha256.slice(0, 12)} mono />
              <KV k="Size" v={`${fmtInt(prompt.size_chars)} chars`} />
              <KV k="≈ Tokens" v={fmtInt(prompt.approx_tokens)} />
              <dd className="mt-1 text-xs leading-relaxed text-(--fg-muted)">{prompt.sections.join(" · ")}</dd>
              <PromptDialog traceId={trace.id} sizeChars={prompt.size_chars} />
            </dl>
          ) : (
            <p className="text-xs text-(--fg-subtle)">Not captured for this turn.</p>
          )}
        </Card>
      )}

      <Card title="Models & cost" bodyClassName={body}>
        <dl>
          <KV k="Model" v={trace.models.length ? trace.models.join(", ") : "—"} />
          <KV k="Tokens in / out" v={`${fmtInt(trace.tokens_input)} / ${fmtInt(trace.tokens_output)}`} />
          <KV k="Cached tokens" v={fmtInt(trace.tokens_cached)} />
          <KV k="Estimated cost" v={fmtUsd(trace.cost_estimate_usd)} />
          {trace.first_token_ms !== null && <KV k="First token" v={`${trace.first_token_ms} ms`} />}
        </dl>
      </Card>

      <Card title="Session" bodyClassName={body}>
        <dl>
          <KV k="Turn" v={trace.turn_id} mono />
          {langfuse && <KV k="Langfuse session" v={langfuse} mono />}
        </dl>
        <Link
          href={`/monitoring/sessions/${encodeURIComponent(trace.session_id)}`}
          className="group mt-2 flex items-center justify-between gap-2 rounded-xl border border-(--border) px-3 py-2 text-xs transition-colors duration-150 hover:border-(--border-strong) hover:bg-(--surface-muted)"
        >
          <span className="min-w-0">
            <span className="block font-medium text-(--fg)">Open conversation</span>
            <span className="block truncate font-mono text-[11px] text-(--fg-subtle)">{trace.session_id}</span>
          </span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-(--fg-subtle) transition-colors group-hover:text-(--fg)" aria-hidden />
        </Link>
      </Card>

      <Card title="Feedback" kicker={feedback.length ? `${feedback.length} event${feedback.length === 1 ? "" : "s"}` : "No votes yet"} bodyClassName={body}>
        {feedback.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-(--fg-subtle)"><MessageSquareText className="h-4 w-4" aria-hidden /> The visitor has not rated this answer.</p>
        ) : (
          <ul className="space-y-3">
            {feedback.map((f) => (
              <li key={f.id} className="text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Thumb thumb={f.thumb} />
                  <span className="tabular text-(--fg-muted)">{fmtTime(f.created_at)}</span>
                  {f.thumb === null && <span className="rounded-md bg-(--surface-muted) px-1.5 py-0.5 text-(--fg-subtle)">retracted</span>}
                  {f.reason && <span className="rounded-md bg-(--surface-muted) px-1.5 py-0.5 font-mono text-[11px] text-(--fg-muted)">{f.reason}</span>}
                </div>
                {f.comment && <blockquote className="mt-1.5 whitespace-pre-wrap rounded-xl border-l-2 border-(--brand-green) bg-(--surface-muted) px-3 py-2 text-[13px] leading-relaxed text-(--fg)">{f.comment}</blockquote>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Version" bodyClassName={body}>
        <dl>
          <KV k="Widget build" v={trace.agent_version ?? "—"} mono />
          <KV k="Environment" v={typeof meta.env === "string" ? meta.env : "—"} />
          {typeof meta.run_id === "string" && <KV k="V3 run" v={meta.run_id.slice(0, 8)} mono />}
        </dl>
      </Card>
    </aside>
  );
}
