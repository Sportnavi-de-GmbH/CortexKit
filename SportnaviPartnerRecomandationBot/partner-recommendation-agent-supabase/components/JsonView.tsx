"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

export function JsonView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === undefined) return <span style={{ color: "var(--text-faint)" }}>undefined</span>;
  if (value === null) return <span style={{ color: "var(--purple)" }}>null</span>;

  if (Array.isArray(value)) {
    return <CollapsibleNode entries={value.map((v, i) => [String(i), v] as const)} bracket={["[", "]"]} depth={depth} />;
  }

  if (typeof value === "object") {
    return (
      <CollapsibleNode
        entries={Object.entries(value as Record<string, unknown>)}
        bracket={["{", "}"]}
        depth={depth}
      />
    );
  }

  if (typeof value === "string") return <span style={{ color: "var(--accent)" }}>&quot;{value}&quot;</span>;
  if (typeof value === "number") return <span style={{ color: "var(--blue)" }}>{value}</span>;
  if (typeof value === "boolean") return <span style={{ color: "var(--yellow)" }}>{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function CollapsibleNode({
  entries,
  bracket,
  depth,
}: {
  entries: readonly (readonly [string, unknown])[];
  bracket: readonly [string, string];
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);

  if (entries.length === 0) {
    return (
      <span style={{ color: "var(--text-faint)" }}>
        {bracket[0]}
        {bracket[1]}
      </span>
    );
  }

  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex cursor-pointer select-none items-center gap-0.5 rounded px-0.5 align-middle hover:bg-black/5"
        style={{ color: "var(--text-dim)" }}
      >
        <span className="inline-flex shrink-0 transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }}>
          <ChevronRight size={10} />
        </span>
        {bracket[0]}
        {!open ? ` … ${bracket[1]}` : ""}
      </button>
      {open && (
        <div style={{ marginLeft: 14, borderLeft: "1px solid var(--border)", paddingLeft: 8 }}>
          {entries.map(([key, v]) => (
            <div key={key} className="py-0.5">
              <span style={{ color: "var(--text-dim)" }}>{key}</span>
              <span style={{ color: "var(--text-faint)" }}>: </span>
              <JsonView value={v} depth={depth + 1} />
            </div>
          ))}
          <div style={{ color: "var(--text-dim)" }}>{bracket[1]}</div>
        </div>
      )}
    </span>
  );
}
