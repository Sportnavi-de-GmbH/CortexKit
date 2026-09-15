// Eight KPI tiles. Hierarchy: kicker label → large tabular value → one-line
// hint. Icons are SVG (lucide), never emoji. Tone colours only where the
// number carries meaning (failed > 0 = red, positive rate = green tint).
import type { ReactNode } from "react";
import { Activity, CircleCheck, CircleX, DollarSign, Gauge, MessageSquareHeart, ThumbsDown, ThumbsUp } from "lucide-react";
import type { Stats } from "@/lib/monitoring/query";
import { CARD, fmtInt, fmtMs, fmtUsd } from "./ui";

function Tile({
  icon,
  label,
  value,
  hint,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const iconTone =
    tone === "good"
      ? "bg-(--accent-dim) text-(--fg)"
      : tone === "bad"
        ? "bg-(--red)/12 text-(--red)"
        : tone === "warn"
          ? "bg-(--warn-surface) text-(--warn-icon)"
          : "bg-(--surface-muted) text-(--fg-muted)";
  const valueTone = tone === "bad" ? "text-(--red)" : "text-(--fg)";
  return (
    <div className={`${CARD} flex items-start gap-3.5 p-4`}>
      {/* The icon tile is hidden on phones so the label and hint keep room on a 2-up grid. */}
      <span className={`mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-full sm:flex ${iconTone}`} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-(--fg-subtle)">{label}</div>
        <div className={`mt-1 font-display text-[24px] font-semibold leading-none tabular sm:text-[26px] ${valueTone}`}>{value}</div>
        {hint && <div className="mt-1.5 text-xs leading-snug text-(--fg-muted)">{hint}</div>}
      </div>
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");

export function KpiTiles({ stats }: { stats: Stats }) {
  const rated = stats.thumbs_up + stats.thumbs_down;
  const ic = "h-4 w-4";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile icon={<Activity className={ic} />} label="Executions" value={fmtInt(stats.executions)} hint="FAQ + Partner turns" />
      <Tile icon={<CircleCheck className={ic} />} label="Success rate" value={pct(stats.succeeded, stats.executions)} hint={`${fmtInt(stats.succeeded)} answered`} tone="good" />
      <Tile
        icon={<CircleX className={ic} />}
        label="Failed"
        value={fmtInt(stats.failed)}
        hint={stats.abandoned ? `plus ${stats.abandoned} abandoned` : "no abandoned runs"}
        tone={stats.failed > 0 ? "bad" : "neutral"}
      />
      <Tile icon={<Gauge className={ic} />} label="Avg latency" value={fmtMs(stats.avg_ms)} hint={`p95 ${fmtMs(stats.p95_ms)}`} />
      <Tile icon={<DollarSign className={ic} />} label="Total cost" value={fmtUsd(stats.cost_usd)} hint="model usage, estimated" />
      <Tile icon={<MessageSquareHeart className={ic} />} label="Positive rate" value={pct(stats.thumbs_up, rated)} hint={`${fmtInt(rated)} rated`} tone={rated > 0 ? "good" : "neutral"} />
      <Tile icon={<ThumbsUp className={ic} />} label="Thumbs up" value={fmtInt(stats.thumbs_up)} tone={stats.thumbs_up > 0 ? "good" : "neutral"} />
      <Tile icon={<ThumbsDown className={ic} />} label="Thumbs down" value={fmtInt(stats.thumbs_down)} tone={stats.thumbs_down > 0 ? "warn" : "neutral"} />
    </div>
  );
}
