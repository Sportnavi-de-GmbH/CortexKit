"use client";
import type { SearchOutput } from "../../workflow/types";
import { fmtKm, fmtScore } from "../../lib/ui/format";
import { NUM, TABLE, TD, TH, TableWrap, RoleBadge } from "./_table";

export function SearchView({ output }: { output: SearchOutput }) {
  const e = output.embedding;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Embedding: <b>{e.model}</b>, {e.dimensions} dims, preview [{e.preview.map((n) => n.toFixed(3)).join(", ")}…]
      </p>
      <p className="text-xs text-zinc-500">Retrieval query: &quot;{output.retrievalQuery}&quot;</p>
      {output.perCity.map((c) => (
        <details key={c.city} open className="rounded border border-zinc-200 dark:border-zinc-800">
          <summary className="cursor-pointer px-3 py-1.5 text-sm">
            <b>{c.city}</b> <RoleBadge role={c.role} /> <span className="text-zinc-500">({fmtKm(c.distanceKm)})</span>
            {" — "}requested <b>{c.requested}</b>, returned <b>{c.returned}</b>, kept <b>{c.kept}</b>
            {c.failed && <span className="ml-2 text-red-700 dark:text-red-300">failed: {c.failed}</span>}
          </summary>
          <div className="px-3 pb-2">
            {c.results.length === 0 ? (
              <p className="py-1 text-xs text-zinc-500">No candidates kept from this city.</p>
            ) : (
              <TableWrap>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th className={`${TH} text-right`}>Rank</th>
                      <th className={TH}>Partner</th>
                      <th className={TH}>Tags</th>
                      <th className={`${TH} text-right`}>Similarity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.results.map((r) => (
                      <tr key={r.id}>
                        <td className={NUM}>{r.rankInCity + 1}</td>
                        <td className={TD}>{r.name} <span className="text-xs text-zinc-400">#{r.id}</span></td>
                        <td className={`${TD} text-xs text-zinc-500`}>
                          {r.tags.slice(0, 6).join(", ")}{r.tags.length > 6 ? ` +${r.tags.length - 6}` : ""}
                        </td>
                        <td className={NUM}>{fmtScore(r.similarity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
