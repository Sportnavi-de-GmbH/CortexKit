// Pure formatters for the dashboard — a .ts file so vitest (no JSX transform
// in this project) can test them; components/monitoring/ui.tsx re-exports.
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")} min`;
}

/** Postgres `numeric` columns arrive as strings through supabase-js. */
export function fmtUsd(usd: number | string | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return `$${Number(usd).toFixed(4)}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-US");
}
