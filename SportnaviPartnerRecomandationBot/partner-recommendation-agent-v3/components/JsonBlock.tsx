"use client";
export function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <details className="rounded border border-zinc-200 dark:border-zinc-800">
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</summary>
      <pre className="max-h-96 overflow-auto px-3 py-2 text-xs leading-5">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
