"use client";
import type { NearbyCitiesOutput } from "../../workflow/types";
import { fmtKm } from "../../lib/ui/format";
import { NUM, TABLE, TD, TH, TableWrap, RoleBadge } from "./_table";

export function NearbyCitiesView({ output }: { output: NearbyCitiesOutput }) {
  return (
    <TableWrap>
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH}>City</th>
            <th className={TH}>Role</th>
            <th className={`${TH} text-right`}>Distance</th>
            <th className={`${TH} text-right`}>Partners in directory</th>
          </tr>
        </thead>
        <tbody>
          {output.cities.map((c) => (
            <tr key={c.city} className={c.role === "target" ? "font-bold" : ""}>
              <td className={TD}>{c.city}</td>
              <td className={TD}><RoleBadge role={c.role} /></td>
              <td className={NUM}>{fmtKm(c.distanceKm)}</td>
              <td className={NUM}>{c.partnerCount}</td>
            </tr>
          ))}
          {output.cities.length === 0 && (
            <tr><td className={TD} colSpan={4}>No cities to search.</td></tr>
          )}
        </tbody>
      </table>
    </TableWrap>
  );
}
