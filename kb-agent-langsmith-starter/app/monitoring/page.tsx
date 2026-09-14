// Overview: KPIs · executions per day · latest errors · filterable trace list.
// Server component reading lib/monitoring/query.ts directly (the data API under
// /api/monitoring/* serves scripts and curl); middleware.ts gates access.
import Link from "next/link";
import { Suspense } from "react";
import { getStats, listTraces, parseTraceFilters, rangeHours, type StatsRange } from "@/lib/monitoring/query";
import { KpiTiles } from "@/components/monitoring/KpiTiles";
import { PerDayBars } from "@/components/monitoring/PerDayBars";
import { TraceFilters } from "@/components/monitoring/TraceFilters";
import { TraceList } from "@/components/monitoring/TraceList";
import { AgentBadge, fmtTime } from "@/components/monitoring/ui";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = new URLSearchParams(
    Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
  );
  const r = sp.get("range");
  const range: StatsRange = r === "7d" || r === "30d" ? r : "24h";
  const filters = parseTraceFilters(sp);
  const since = new Date(Date.now() - rangeHours(range) * 3_600_000).toISOString();
  const [stats, list] = await Promise.all([getStats(range), listTraces({ ...filters, from: filters.from ?? since })]);

  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <TraceFilters />
      </Suspense>
      {stats ? (
        <KpiTiles stats={stats} />
      ) : (
        <p className="rounded-2xl border border-(--border) bg-(--surface) p-4 text-sm text-(--fg-muted)">
          Monitoring database not configured (MONITORING_SUPABASE_URL / _SERVICE_ROLE_KEY).
        </p>
      )}
      {stats && (
        <div className="grid gap-4 lg:grid-cols-3">
          <section className="rounded-2xl border border-(--border) bg-(--surface) p-4 lg:col-span-2">
            <h2 className="mb-3 font-display text-sm font-semibold">Executions per day</h2>
            <PerDayBars perDay={stats.per_day} />
          </section>
          <section className="rounded-2xl border border-(--border) bg-(--surface) p-4">
            <h2 className="mb-3 font-display text-sm font-semibold">Latest errors</h2>
            {stats.latest_errors.length === 0 ? (
              <p className="text-sm text-(--fg-subtle)">None in this range.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {stats.latest_errors.map((e) => (
                  <li key={e.id}>
                    <Link href={`/monitoring/traces/${e.trace_id}`} className="block rounded-lg p-2 hover:bg-(--surface-muted)">
                      <div className="flex items-center gap-2 text-xs text-(--fg-subtle)">
                        <AgentBadge agent={e.agent} />
                        {fmtTime(e.created_at)} · {e.type}
                      </div>
                      <div className={`truncate ${e.level === "error" ? "text-(--red)" : "text-(--warn-fg)"}`}>{e.message}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      <TraceList items={list.items} nextCursor={list.nextCursor} params={sp} />
    </div>
  );
}
