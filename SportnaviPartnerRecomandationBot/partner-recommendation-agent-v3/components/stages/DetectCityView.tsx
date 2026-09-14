"use client";
import type { DetectCityOutput } from "../../workflow/types";
import { fmtScore } from "../../lib/ui/format";
import { NUM, TABLE, TD, TH, TableWrap } from "./_table";

export function DetectCityView({ output }: { output: DetectCityOutput }) {
  const t = output.target;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {t ? (
          <>
            Target city: <b>{t.canonical}</b>{" "}
            <span className="text-zinc-500">(source: {t.source}, confidence {fmtScore(t.confidence)}, mention &quot;{t.mention}&quot;)</span>
          </>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">
            No city determined{output.cityMention ? ` (mention: "${output.cityMention}")` : ""}
          </span>
        )}
      </p>
      {output.attempts.length > 0 && (
        <TableWrap>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Source</th>
                <th className={TH}>Mention</th>
                <th className={TH}>Resolved</th>
                <th className={`${TH} text-right`}>Confidence</th>
                <th className={TH}>Accepted</th>
                <th className={TH}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {output.attempts.map((a, i) => (
                <tr key={i} className={a.accepted ? "" : "opacity-60"}>
                  <td className={TD}>{a.source}</td>
                  <td className={TD}>{a.mention}</td>
                  <td className={TD}>{a.resolved ? a.resolved.canonical : <span className="text-zinc-400">—</span>}</td>
                  <td className={NUM}>{fmtScore(a.resolved?.confidence)}</td>
                  <td className={TD}>{a.accepted ? "✔ yes" : "✖ no"}</td>
                  <td className={TD}>{a.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}
