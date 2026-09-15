// Shared primitives of the monitoring dashboard: class constants, pills,
// badges, cards. One place for radius / border / elevation so every screen
// reads the same. Colour rule (docs/design/WIDGET-DESIGN-GUIDELINES.md):
// brand-green = success/AI, brand-orange = warning/partner, a neutral red ONLY
// inside the dashboard for errors. Text never sits in raw brand green (~1.9:1).
import type { ReactNode } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

export { fmtInt, fmtMs, fmtTime, fmtUsd } from "./format";

/* ---------------------------------------------------------------- tokens */
export const CARD = "rounded-2xl border border-(--border) bg-(--surface)";
export const CARD_HOVER = "transition-[box-shadow,border-color] duration-200 hover:border-(--border-strong) hover:soft-shadow";
export const INPUT =
  "h-10 w-full rounded-xl border border-(--border) bg-(--surface) px-3 text-sm text-(--fg) outline-none transition-colors placeholder:text-(--fg-subtle) focus:border-(--brand-green)";
export const SELECT = `${INPUT} pr-8 appearance-none`;
export const BTN_PRIMARY =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-(--brand-green) px-5 font-display text-sm font-semibold text-(--ink) transition-transform duration-150 hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100";
export const BTN_SECONDARY =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-(--border) bg-(--surface) px-3.5 text-sm font-medium text-(--fg-muted) transition-colors duration-150 hover:border-(--border-strong) hover:text-(--fg)";
export const BTN_GHOST =
  "inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-(--fg-muted) transition-colors duration-150 hover:bg-(--surface-muted) hover:text-(--fg)";
/** Circular icon button, 36px visual / 44px hit area (touch rule). */
export const ICON_BTN =
  "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-(--border) text-(--fg-muted) transition-colors duration-150 hover:bg-(--surface-muted) hover:text-(--fg) after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

/* ---------------------------------------------------------------- layout */
export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-(--fg-subtle) ${className}`}>{children}</div>;
}

export function Card({
  title,
  kicker,
  actions,
  children,
  className = "",
  bodyClassName = "p-5",
}: {
  title?: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`${CARD} min-w-0 ${className}`}>
      {(title || actions || kicker) && (
        <header className="flex items-start justify-between gap-3 border-b border-(--border) px-5 py-3.5">
          <div className="min-w-0">
            {kicker && <Kicker>{kicker}</Kicker>}
            {title && <h2 className="font-display text-[15px] font-semibold leading-tight text-(--fg)">{title}</h2>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Key / value line used in sidebars and summary strips. */
export function KV({ k, v, mono = false }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-(--fg-muted)">{k}</dt>
      <dd className={`min-w-0 truncate text-right font-medium text-(--fg) ${mono ? "font-mono text-xs" : "tabular"}`}>{v}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- pills */
const PILL: Record<string, { cls: string; dot: string; label: string }> = {
  completed: { cls: "bg-(--accent-dim) text-(--fg)", dot: "bg-(--brand-green)", label: "Completed" },
  ok: { cls: "bg-(--accent-dim) text-(--fg)", dot: "bg-(--brand-green)", label: "OK" },
  needs_clarification: { cls: "bg-(--warn-surface) text-(--warn-fg)", dot: "bg-(--warn-icon)", label: "Needs clarification" },
  partial: { cls: "bg-(--warn-surface) text-(--warn-fg)", dot: "bg-(--warn-icon)", label: "Partial" },
  warning: { cls: "bg-(--warn-surface) text-(--warn-fg)", dot: "bg-(--warn-icon)", label: "Warning" },
  failed: { cls: "bg-(--red)/12 text-(--red)", dot: "bg-(--red)", label: "Failed" },
  error: { cls: "bg-(--red)/12 text-(--red)", dot: "bg-(--red)", label: "Error" },
  abandoned: { cls: "bg-(--red)/12 text-(--red)", dot: "bg-(--red)", label: "Abandoned" },
  running: { cls: "bg-(--surface-muted) text-(--fg-muted)", dot: "bg-(--fg-subtle) animate-pulse", label: "Running" },
  skipped: { cls: "bg-(--surface-muted) text-(--fg-subtle)", dot: "bg-(--border-strong)", label: "Skipped" },
};

export function StatusPill({ status, abandoned, size = "sm" }: { status: string; abandoned?: boolean; size?: "sm" | "md" }) {
  const s = PILL[abandoned ? "abandoned" : status] ?? PILL.running;
  const dim = size === "md" ? "h-7 px-2.5 text-[12.5px]" : "h-6 px-2 text-[12px]";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-display font-medium ${dim} ${s.cls}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export function AgentBadge({ agent, size = "sm" }: { agent: "faq" | "partner"; size?: "sm" | "md" }) {
  const dim = size === "md" ? "h-7 px-2.5 text-[12px]" : "h-6 px-2 text-[11px]";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-(--border) bg-(--surface) font-display font-semibold uppercase tracking-wide text-(--fg-muted) ${dim}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${agent === "faq" ? "bg-(--brand-green)" : "bg-(--brand-orange)"}`} aria-hidden />
      {agent === "faq" ? "FAQ" : "Partner"}
    </span>
  );
}

export function Thumb({ thumb, className = "h-4 w-4" }: { thumb: "up" | "down" | null; className?: string }) {
  if (thumb === "up") return <ThumbsUp className={`${className} text-(--brand-green)`} aria-label="Thumbs up" />;
  if (thumb === "down") return <ThumbsDown className={`${className} text-(--red)`} aria-label="Thumbs down" />;
  return <span className="text-(--fg-subtle)" aria-label="No feedback">—</span>;
}

/** Small icon-led statistic for summary strips. */
export function Stat({ icon, label, value, tone = "default" }: { icon: ReactNode; label: string; value: ReactNode; tone?: "default" | "bad" | "good" }) {
  const color = tone === "bad" ? "text-(--red)" : tone === "good" ? "text-(--fg)" : "text-(--fg)";
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--surface-muted) text-(--fg-muted)">{icon}</span>
      <div className="min-w-0 leading-tight">
        <div className="text-[11px] text-(--fg-subtle)">{label}</div>
        <div className={`font-display text-sm font-semibold tabular ${color}`}>{value}</div>
      </div>
    </div>
  );
}
