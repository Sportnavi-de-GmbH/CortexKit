// Sticky right rail of the trace detail: prompt version, models, tokens, cost,
// session link, feedback history, Langfuse id, build version.
import Link from "next/link";
import type { FeedbackRow, PromptRow, TraceRow } from "@/lib/monitoring/query";
import { PromptDialog } from "./PromptDialog";
import { Thumb, fmtInt, fmtTime, fmtUsd } from "./ui";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-(--border) bg-(--surface) p-3">
      <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-wide text-(--fg-subtle)">{title}</h3>
      <div className="space-y-1 text-sm">{children}</div>
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3">
    <span className="text-(--fg-muted)">{k}</span>
    <span className="text-right font-medium">{v}</span>
  </div>
);

export function TraceSidebar({ trace, prompt, feedback }: { trace: TraceRow; prompt: PromptRow | null; feedback: FeedbackRow[] }) {
  const meta = trace.metadata ?? {};
  const langfuse = typeof meta.langfuse_session_id === "string" ? meta.langfuse_session_id : null;
  return (
    <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
      {trace.agent === "faq" && (
        <Card title="Prompt version">
          {prompt ? (
            <>
              <Row k="Fingerprint" v={<span className="font-mono text-xs">{prompt.sha256.slice(0, 12)}</span>} />
              <Row k="Size" v={`${fmtInt(prompt.size_chars)} chars · ~${fmtInt(prompt.approx_tokens)} tokens`} />
              <div className="text-xs text-(--fg-muted)">{prompt.sections.join(" · ")}</div>
              <PromptDialog traceId={trace.id} sizeChars={prompt.size_chars} />
            </>
          ) : (
            <span className="text-xs text-(--fg-subtle)">Not captured for this turn.</span>
          )}
        </Card>
      )}
      <Card title="Models & cost">
        <Row k="Models" v={trace.models.length ? trace.models.join(", ") : "—"} />
        <Row k="Tokens in / out" v={`${fmtInt(trace.tokens_input)} / ${fmtInt(trace.tokens_output)}`} />
        <Row k="Cached" v={fmtInt(trace.tokens_cached)} />
        <Row k="Cost" v={fmtUsd(trace.cost_estimate_usd)} />
        {trace.first_token_ms !== null && <Row k="First token" v={`${trace.first_token_ms} ms`} />}
      </Card>
      <Card title="Session">
        <Link href={`/monitoring/sessions/${encodeURIComponent(trace.session_id)}`} className="block truncate font-mono text-xs text-(--brand-green) hover:underline">
          {trace.session_id}
        </Link>
        <Row k="Turn" v={trace.turn_id} />
        {langfuse && <Row k="Langfuse session" v={<span className="font-mono text-xs">{langfuse}</span>} />}
      </Card>
      <Card title="Feedback history">
        {feedback.length === 0 ? (
          <span className="text-xs text-(--fg-subtle)">No votes yet.</span>
        ) : (
          <ul className="space-y-2">
            {feedback.map((f) => (
              <li key={f.id} className="text-xs">
                <div className="flex items-center gap-2">
                  <Thumb thumb={f.thumb} />
                  <span className="text-(--fg-muted)">{fmtTime(f.created_at)}</span>
                  {f.thumb === null && <span className="text-(--fg-subtle)">retracted</span>}
                  {f.reason && <span className="rounded-md bg-(--surface-muted) px-1.5 py-0.5">{f.reason}</span>}
                </div>
                {f.comment && <div className="mt-1 whitespace-pre-wrap rounded-lg bg-(--surface-muted) p-2">{f.comment}</div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Version">
        <Row k="Widget build" v={<span className="font-mono text-xs">{trace.agent_version ?? "—"}</span>} />
        <Row k="Environment" v={typeof meta.env === "string" ? meta.env : "—"} />
        {typeof meta.run_id === "string" && <Row k="V3 run" v={<span className="font-mono text-xs">{meta.run_id.slice(0, 8)}</span>} />}
      </Card>
    </aside>
  );
}
