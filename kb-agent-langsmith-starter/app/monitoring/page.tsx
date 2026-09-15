// Overview: title · filters · KPIs · executions per day + latest errors · executions table.
// Server component reading lib/monitoring/query.ts directly (the data API under
// /api/monitoring/* serves scripts and curl); middleware.ts gates access.
import Link from "next/link";
import { Suspense } from "react";
import { AlertTriangle, CircleCheck } from "lucide-react";
import { getStats, listTraces, parseTraceFilters, rangeHours, type StatsRange } from "@/lib/monitoring/query";
import { BreachBanner } from "@/components/monitoring/BreachBanner";
import { KpiTiles } from "@/components/monitoring/KpiTiles";
import { PageHeader } from "@/components/monitoring/PageHeader";
import { PerDayBars } from "@/components/monitoring/PerDayBars";
import { TraceFilters } from "@/components/monitoring/TraceFilters";
import { TraceList } from "@/components/monitoring/TraceList";
import { AgentBadge, Card, fmtTime } from "@/components/monitoring/ui";

export const dynamic = "force-dynamic";

const RANGE_LABEL: Record<StatsRange, string> = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };

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
  const agentLabel = filters.agent === "faq" ? "FAQ agent" : filters.agent === "partner" ? "Partner agent" : "both agents";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`What the Navio agents did in the ${RANGE_LABEL[range]} — ${agentLabel}. Click an execution to see every step.`}
      />

      {/* Streams in: a slow alert-state query must not hold up the KPIs. Suspense covers the
          pending case only — a failing query is swallowed inside breachedStates(). */}
      <Suspense fallback={null}>
        <BreachBanner />
      </Suspense>

      <Suspense fallback={null}>
        <TraceFilters />
      </Suspense>

      {stats ? (
        <KpiTiles stats={stats} />
      ) : (
        <Card>
          <p className="text-sm text-(--fg-muted)">Monitoring database not configured (MONITORING_SUPABASE_URL / _SERVICE_ROLE_KEY).</p>
        </Card>
      )}

      {stats && (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
          <Card title="Executions per day" kicker={RANGE_LABEL[range]} className="lg:col-span-2">
            <PerDayBars perDay={stats.per_day} />
          </Card>
          <Card title="Latest errors" kicker="Newest first" bodyClassName="max-h-[21rem] overflow-y-auto p-2">
            {stats.latest_errors.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <CircleCheck className="h-6 w-6 text-(--brand-green)" aria-hidden />
                <p className="text-sm text-(--fg-muted)">No errors in this range.</p>
              </div>
            ) : (
              <ul className="divide-y divide-(--border)">
                {stats.latest_errors.map((e) => (
                  <li key={e.id}>
                    <Link href={`/monitoring/traces/${e.trace_id}`} className="group flex gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-(--surface-muted)">
                      <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${e.level === "error" ? "text-(--red)" : "text-(--warn-icon)"}`} aria-hidden />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-[11px] text-(--fg-subtle)">
                          <AgentBadge agent={e.agent} />
                          <span className="tabular">{fmtTime(e.created_at)}</span>
                          <span className="font-mono">{e.type}</span>
                        </span>
                        <span className="mt-1 line-clamp-2 block break-words text-[13px] leading-snug text-(--fg)">{e.message}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <TraceList items={list.items} nextCursor={list.nextCursor} params={sp} />
    </div>
  );
}
