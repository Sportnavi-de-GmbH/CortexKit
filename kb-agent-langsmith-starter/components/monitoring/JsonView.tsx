"use client";

// Pretty JSON (or wrapped text) with Copy and a "show all" for large payloads.
import { useState } from "react";
import { Check, Copy } from "lucide-react";

const LIMIT = 4000;

export function JsonView({ value, label }: { value: unknown; label: string }) {
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const isText = typeof value === "string";
  const full = isText ? (value as string) : JSON.stringify(value, null, 2);
  if (value === null || value === undefined || full === "{}" || full === "[]" || full === "") {
    return (
      <div>
        <div className="mb-1 text-xs font-medium text-(--fg-subtle)">{label}</div>
        <div className="text-xs text-(--fg-subtle)">(empty)</div>
      </div>
    );
  }
  const shown = all || full.length <= LIMIT ? full : full.slice(0, LIMIT);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-(--fg-subtle)">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(full).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-(--fg-muted) hover:bg-(--surface-muted)"
        >
          {copied ? <Check className="h-3 w-3 text-(--brand-green)" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={`max-h-96 overflow-auto rounded-xl bg-(--surface-muted) p-3 text-xs ${isText ? "whitespace-pre-wrap font-body" : "font-mono"}`}>
        {shown}
      </pre>
      {full.length > LIMIT && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 text-xs font-medium text-(--brand-green) hover:underline">
          Show all ({Math.round(full.length / 1024)} KB)
        </button>
      )}
    </div>
  );
}
