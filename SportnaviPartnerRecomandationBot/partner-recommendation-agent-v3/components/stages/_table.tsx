"use client";
/** Tiny shared table primitives so every stage view looks the same. */
export const TABLE = "w-full text-left text-sm";
export const TH = "border-b border-zinc-200 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700";
export const TD = "border-b border-zinc-100 px-2 py-1 align-top dark:border-zinc-800";
export const NUM = `${TD} text-right tabular-nums`;

export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">{children}</div>;
}

export function RoleBadge({ role }: { role: "target" | "nearby" }) {
  const cls = role === "target"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{role}</span>;
}
