import type { Stats } from "@/lib/monitoring/query";

/** Stacked bar per day — FAQ green, Partner orange. Pure CSS, no chart lib. */
export function PerDayBars({ perDay }: { perDay: Stats["per_day"] }) {
  const byDay = new Map<string, { faq: number; partner: number }>();
  for (const row of perDay) {
    const d = byDay.get(row.day) ?? { faq: 0, partner: 0 };
    d[row.agent] += Number(row.n);
    byDay.set(row.day, d);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (days.length === 0) return <p className="text-sm text-(--fg-subtle)">No executions in this range.</p>;
  const max = Math.max(...days.map(([, d]) => d.faq + d.partner), 1);
  return (
    <div>
      <div className="flex h-40 items-stretch gap-2 overflow-x-auto">
        {days.map(([day, d]) => {
          const total = d.faq + d.partner;
          return (
            // The column stretches to the row's fixed height, so the percentage
            // height of the bar wrapper below resolves against a definite size.
            <div key={day} className="flex min-w-8 flex-1 flex-col items-center justify-end gap-1" title={`${day}: ${d.faq} FAQ · ${d.partner} Partner`}>
              <div className="flex w-full flex-col justify-end" style={{ height: `${Math.max(2, (total / max) * 100)}%` }}>
                <div className="w-full rounded-t-md bg-(--brand-orange)" style={{ height: `${total ? (d.partner / total) * 100 : 0}%` }} />
                <div className="w-full rounded-b-md bg-(--brand-green)" style={{ height: `${total ? (d.faq / total) * 100 : 0}%` }} />
              </div>
              <div className="text-[10px] text-(--fg-subtle)">{day.slice(5)}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-(--fg-muted)">
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-(--brand-green)" /> FAQ</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-(--brand-orange)" /> Partner</span>
      </div>
    </div>
  );
}
