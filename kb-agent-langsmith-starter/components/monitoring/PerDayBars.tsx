// Executions per day as stacked bars — FAQ green, Partner orange. Pure CSS.
// Value labels on every bar (chart rule: never rely on eyeballing height),
// a baseline, and a legend that doubles as the colour key.
import type { Stats } from "@/lib/monitoring/query";

export function PerDayBars({ perDay }: { perDay: Stats["per_day"] }) {
  const byDay = new Map<string, { faq: number; partner: number }>();
  for (const row of perDay) {
    const d = byDay.get(row.day) ?? { faq: 0, partner: 0 };
    d[row.agent] += Number(row.n);
    byDay.set(row.day, d);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (days.length === 0) {
    return (
      <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-(--border) text-sm text-(--fg-subtle)">
        No executions in this range.
      </div>
    );
  }
  const max = Math.max(...days.map(([, d]) => d.faq + d.partner), 1);
  const totalFaq = days.reduce((a, [, d]) => a + d.faq, 0);
  const totalPartner = days.reduce((a, [, d]) => a + d.partner, 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-(--fg-muted)">
        <span>
          {days.length} day{days.length === 1 ? "" : "s"} · peak {max} / day
        </span>
        <span className="flex gap-4">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-(--brand-green)" aria-hidden /> FAQ <span className="tabular text-(--fg-subtle)">{totalFaq}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-(--brand-orange)" aria-hidden /> Partner <span className="tabular text-(--fg-subtle)">{totalPartner}</span>
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex h-44 min-w-full items-stretch gap-1.5 border-b border-(--border-strong) pb-0" role="img" aria-label="Executions per day, stacked by agent">
          {days.map(([day, d]) => {
            const total = d.faq + d.partner;
            return (
              <div
                key={day}
                className="group flex min-w-9 flex-1 flex-col items-center justify-end"
                title={`${day}: ${d.faq} FAQ · ${d.partner} Partner`}
              >
                <div className="mb-1 font-display text-[11px] font-semibold tabular text-(--fg-muted) opacity-80 transition-opacity group-hover:opacity-100">{total}</div>
                {/* The column stretches to the row's fixed height, so the percentage
                    height of this wrapper resolves against a definite size. */}
                <div className="flex w-full max-w-14 flex-col justify-end overflow-hidden rounded-t-md" style={{ height: `${Math.max(3, (total / max) * 82)}%` }}>
                  <div className="w-full bg-(--brand-orange) transition-opacity group-hover:opacity-90" style={{ height: `${total ? (d.partner / total) * 100 : 0}%` }} />
                  <div className="w-full bg-(--brand-green) transition-opacity group-hover:opacity-90" style={{ height: `${total ? (d.faq / total) * 100 : 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-1.5 pt-1.5">
          {days.map(([day]) => (
            <div key={day} className="min-w-9 flex-1 text-center text-[11px] tabular text-(--fg-subtle)">
              {day.slice(5).replace("-", "/")}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
