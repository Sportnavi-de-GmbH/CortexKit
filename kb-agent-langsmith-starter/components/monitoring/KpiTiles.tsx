import type { Stats } from "@/lib/monitoring/query";
import { fmtInt, fmtMs, fmtUsd } from "./ui";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-(--border) bg-(--surface) p-4">
      <div className="text-xs text-(--fg-subtle)">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-(--fg-muted)">{hint}</div>}
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");

export function KpiTiles({ stats }: { stats: Stats }) {
  const rated = stats.thumbs_up + stats.thumbs_down;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile label="Executions" value={fmtInt(stats.executions)} />
      <Tile label="Success rate" value={pct(stats.succeeded, stats.executions)} hint={`${stats.succeeded} answered`} />
      <Tile label="Failed" value={fmtInt(stats.failed)} hint={stats.abandoned ? `+ ${stats.abandoned} abandoned` : undefined} />
      <Tile label="Avg latency" value={fmtMs(stats.avg_ms)} hint={`p95 ${fmtMs(stats.p95_ms)}`} />
      <Tile label="Total cost" value={fmtUsd(stats.cost_usd)} />
      <Tile label="Positive rate" value={pct(stats.thumbs_up, rated)} hint={`${rated} rated`} />
      <Tile label="👍" value={fmtInt(stats.thumbs_up)} />
      <Tile label="👎" value={fmtInt(stats.thumbs_down)} />
    </div>
  );
}
