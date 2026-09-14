"use client";
import ReactMarkdown from "react-markdown";
import type { RespondOutput } from "../../workflow/types";
import { fmtKm, fmtScore } from "../../lib/ui/format";
import { NUM, TABLE, TD, TH, TableWrap, RoleBadge } from "./_table";

const ANSWER_CARD =
  "max-w-none rounded border border-emerald-200 bg-emerald-50/40 p-4 text-sm leading-6 dark:border-emerald-900 dark:bg-emerald-950/20 " +
  "[&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_p]:my-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_a]:underline";

export function RespondView({ output }: { output: RespondOutput }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Profiles given to the model: <b>{output.profilesGiven}</b>
        {output.model ? <span className="text-zinc-500"> · {output.model}</span> : null}
      </p>
      <div className={ANSWER_CARD}>
        <ReactMarkdown>{output.answer}</ReactMarkdown>
      </div>
      {output.recommendations.length > 0 && (
        <>
          <TableWrap>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={`${TH} text-right`}>Rank</th>
                  <th className={TH}>Partner</th>
                  <th className={TH}>City</th>
                  <th className={TH}>Role</th>
                  <th className={`${TH} text-right`}>Distance</th>
                  <th className={`${TH} text-right`}>Final score</th>
                  <th className={`${TH} text-right`}>Relevance</th>
                </tr>
              </thead>
              <tbody>
                {output.recommendations.map((r) => (
                  <tr key={r.id}>
                    <td className={NUM}>{r.rank}</td>
                    <td className={TD}>{r.name} <span className="text-xs text-zinc-400">#{r.id}</span></td>
                    <td className={TD}>{r.city}</td>
                    <td className={TD}><RoleBadge role={r.role} /></td>
                    <td className={NUM}>{fmtKm(r.distanceKm)}</td>
                    <td className={`${NUM} font-bold`}>{fmtScore(r.finalScore)}</td>
                    <td className={NUM}>{fmtScore(r.relevance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="space-y-1">
            {output.recommendations.map((r) => (
              <details key={r.id} className="rounded border border-zinc-200 dark:border-zinc-800">
                <summary className="cursor-pointer px-3 py-1.5 text-xs">
                  Profile given to the model — #{r.rank} {r.name} ({r.city})
                </summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs leading-5">{r.profile}</pre>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
