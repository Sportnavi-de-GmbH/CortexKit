"use client";
import type { DecomposeOutput } from "../../workflow/types";
import { NUM, TABLE, TD, TH, TableWrap } from "./_table";

export function DecomposeView({ output }: { output: DecomposeOutput }) {
  const slot = (id: string) => (output.runnable.some((t) => t.id === id) ? "run now" : "deferred");
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {output.tasks.length} task(s) · {output.runnable.length} run now · {output.deferred.length} deferred
        {output.degraded ? <span className="text-amber-700 dark:text-amber-300"> · degraded (whole message = one task)</span> : null}
        {output.model ? <span className="text-zinc-500"> · {output.model}</span> : null}
      </p>
      <TableWrap>
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={`${TH} text-right`}>Prio</th><th className={TH}>Id</th><th className={TH}>Label</th><th className={TH}>Query</th><th className={TH}>City mention</th><th className={TH}>Slot</th>
            </tr>
          </thead>
          <tbody>
            {output.tasks.map((t) => (
              <tr key={t.id} className={slot(t.id) === "deferred" ? "opacity-60" : ""}>
                <td className={NUM}>{t.priority}</td>
                <td className={`${TD} font-mono text-xs`}>{t.id}</td>
                <td className={TD}>{t.label}</td>
                <td className={TD}>{t.query}</td>
                <td className={TD}>{t.cityMention ?? <span className="text-zinc-400">—</span>}</td>
                <td className={TD}>{slot(t.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
