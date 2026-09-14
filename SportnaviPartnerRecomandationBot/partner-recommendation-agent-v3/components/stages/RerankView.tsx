"use client";
import { useMemo, useState } from "react";
import type { RankedRow, RerankOutput } from "../../workflow/types";
import { fmtKm, fmtScore } from "../../lib/ui/format";
import { NUM, TABLE, TD, TH, TableWrap, RoleBadge } from "./_table";

type SortKey = "rank" | "distanceKm" | "similarity" | "relevance" | "locationTerm" | "finalScore";

const NUMERIC: { key: SortKey; label: string }[] = [
  { key: "distanceKm", label: "Distance" },
  { key: "similarity", label: "Similarity" },
  { key: "relevance", label: "Relevance" },
  { key: "locationTerm", label: "Location term" },
  { key: "finalScore", label: "Final score" },
];

function num(row: RankedRow, key: SortKey): number {
  const v = row[key];
  return typeof v === "number" ? v : Number.NEGATIVE_INFINITY;
}

export function RerankView({ output }: { output: RerankOutput }) {
  const [sortKey, setSortKey] = useState<SortKey>("finalScore");
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const copy = [...output.rows];
    copy.sort((a, b) => {
      if (sortKey === "rank") {
        // dropped rows have rank null → always last
        const ra = a.rank ?? Number.POSITIVE_INFINITY;
        const rb = b.rank ?? Number.POSITIVE_INFINITY;
        return desc ? rb - ra : ra - rb;
      }
      const d = num(a, sortKey) - num(b, sortKey);
      return desc ? -d : d;
    });
    return copy;
  }, [output.rows, sortKey, desc]);

  function clickSort(k: SortKey) {
    if (k === sortKey) setDesc((d) => !d);
    else { setSortKey(k); setDesc(k !== "rank"); }
  }
  const arrow = (k: SortKey) => (k === sortKey ? (desc ? " ↓" : " ↑") : "");
  const kept = output.rows.filter((r) => r.kept).length;

  return (
    <div className="space-y-2">
      <p className="text-sm">
        Reranker: <b>{output.reranker}</b> · {output.rows.length} candidates → <b>{kept} kept</b>, {output.rows.length - kept} dropped
        <span className="ml-2 text-xs text-zinc-500">final = relevance + location term · click a numeric header to sort</span>
      </p>
      <TableWrap>
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={`${TH} cursor-pointer text-right`} onClick={() => clickSort("rank")}>Rank{arrow("rank")}</th>
              <th className={TH}>Partner</th>
              <th className={TH}>City</th>
              <th className={TH}>Role</th>
              {NUMERIC.map((c) => (
                <th
                  key={c.key}
                  className={`${TH} cursor-pointer text-right ${c.key === "finalScore" ? "text-zinc-800 dark:text-zinc-100" : ""}`}
                  onClick={() => clickSort(c.key)}
                >
                  {c.label}{arrow(c.key)}
                </th>
              ))}
              <th className={TH}>Kept / drop reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.kept ? "" : "opacity-50"}>
                <td className={NUM}>{r.rank ?? "—"}</td>
                <td className={TD}>{r.name} <span className="text-xs text-zinc-400">#{r.id}</span></td>
                <td className={TD}>{r.city}</td>
                <td className={TD}><RoleBadge role={r.role} /></td>
                <td className={NUM}>{fmtKm(r.distanceKm)}</td>
                <td className={NUM}>{fmtScore(r.similarity)}</td>
                <td className={`${NUM} whitespace-nowrap`}>
                  {fmtScore(r.relevance)}{" "}
                  <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800" title={`relevance source: ${r.relevanceSource}`}>
                    {r.relevanceSource === "embedding" ? "emb" : r.relevanceSource === "similarity" ? "sim" : "none"}
                  </span>
                </td>
                <td className={NUM}>{r.locationTerm >= 0 ? "+" : ""}{fmtScore(r.locationTerm)}</td>
                <td className={`${NUM} font-bold`}>{fmtScore(r.finalScore)}</td>
                <td className={`${TD} whitespace-nowrap`}>
                  {r.kept
                    ? <span className="text-emerald-700 dark:text-emerald-300">✔ kept</span>
                    : <span className="text-red-700 dark:text-red-300">✖ {r.dropReason ?? "dropped"}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td className={TD} colSpan={10}>No candidates reached the reranker.</td></tr>
            )}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
