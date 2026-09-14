import type { StageStatus, WorkflowStatus } from "../../workflow/types";
export const fmtScore = (n: number | null | undefined): string => (typeof n === "number" ? n.toFixed(4) : "—");
export const fmtKm = (n: number): string => (n < 0.05 ? "0 km" : `${Math.round(n * 10) / 10} km`);
export function statusColor(s: StageStatus | WorkflowStatus): string {
  switch (s) {
    case "ok": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "warning": case "needs_clarification": return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "error": case "failed": return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
    default: return "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  }
}
