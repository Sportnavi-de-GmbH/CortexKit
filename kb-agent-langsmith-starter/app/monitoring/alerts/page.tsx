// Alerts: feed of fired/recovered/digest/test events + editable rules and recipients.
import { Suspense } from "react";
import { PageHeader } from "@/components/monitoring/PageHeader";
import { AlertFeed } from "@/components/monitoring/AlertFeed";
import { AlertRules } from "@/components/monitoring/AlertRules";
import { getAlertSettings, listAlertEvents, listAlertRules, parseEventFilters } from "@/lib/monitoring/alerts/query";

export const dynamic = "force-dynamic";

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams(
    Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
  );
  const tab = sp.get("tab") === "rules" ? "rules" : "feed";
  const [events, rules, settings] = await Promise.all([listAlertEvents(parseEventFilters(sp)), listAlertRules(), getAlertSettings()]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Regelbasierte Alarme aus den Monitoring-Daten — zweimal täglich ausgewertet, Meldungen an Teams und E-Mail."
      />
      <nav aria-label="Tabs" className="flex gap-1">
        {(["feed", "rules"] as const).map((t) => (
          <a
            key={t}
            href={`/monitoring/alerts?tab=${t}`}
            aria-current={tab === t ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 font-display text-sm font-medium transition-colors ${
              tab === t ? "bg-(--surface-muted) text-(--fg)" : "text-(--fg-muted) hover:bg-(--surface-muted) hover:text-(--fg)"
            }`}
          >
            {t === "feed" ? "Feed" : "Regeln"}
          </a>
        ))}
      </nav>
      <Suspense fallback={null}>
        {tab === "feed" ? <AlertFeed initial={events} params={sp.toString()} /> : <AlertRules rules={rules} settings={settings} />}
      </Suspense>
    </div>
  );
}
