// Small shared pieces of the monitoring dashboard: formatters and the three
// pills. Colour rule (docs/design/WIDGET-DESIGN-GUIDELINES.md): brand-green =
// success/AI, brand-orange = warning/human hand-off, a neutral red ONLY inside
// the dashboard for errors.
import { ThumbsDown, ThumbsUp } from "lucide-react";

export { fmtInt, fmtMs, fmtTime, fmtUsd } from "./format";

const PILL: Record<string, string> = {
  completed: "bg-(--accent-dim) text-(--brand-green)",
  needs_clarification: "bg-(--warn-surface) text-(--warn-fg)",
  partial: "bg-(--warn-surface) text-(--warn-fg)",
  failed: "bg-[rgba(244,63,94,0.12)] text-(--red)",
  running: "bg-(--surface-muted) text-(--fg-muted)",
  abandoned: "bg-[rgba(244,63,94,0.12)] text-(--red)",
  ok: "bg-(--accent-dim) text-(--brand-green)",
  warning: "bg-(--warn-surface) text-(--warn-fg)",
  error: "bg-[rgba(244,63,94,0.12)] text-(--red)",
  skipped: "bg-(--surface-muted) text-(--fg-subtle)",
};
const LABEL: Record<string, string> = {
  completed: "Completed",
  needs_clarification: "Needs clarification",
  partial: "Partial",
  failed: "Failed",
  running: "Running",
  abandoned: "Abandoned",
  ok: "OK",
  warning: "Warning",
  error: "Error",
  skipped: "Skipped",
};

export function StatusPill({ status, abandoned }: { status: string; abandoned?: boolean }) {
  const s = abandoned ? "abandoned" : status;
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-display text-[12px] font-medium ${PILL[s] ?? PILL.running}`}>
      {LABEL[s] ?? s}
    </span>
  );
}

export function AgentBadge({ agent }: { agent: "faq" | "partner" }) {
  return (
    <span className="inline-flex rounded-md border border-(--border) px-1.5 py-0.5 font-display text-[11px] font-semibold uppercase tracking-wide text-(--fg-muted)">
      {agent === "faq" ? "FAQ" : "Partner"}
    </span>
  );
}

export function Thumb({ thumb }: { thumb: "up" | "down" | null }) {
  if (thumb === "up") return <ThumbsUp className="h-4 w-4 text-(--brand-green)" aria-label="thumbs up" />;
  if (thumb === "down") return <ThumbsDown className="h-4 w-4 text-(--red)" aria-label="thumbs down" />;
  return <span className="text-(--fg-subtle)">—</span>;
}
