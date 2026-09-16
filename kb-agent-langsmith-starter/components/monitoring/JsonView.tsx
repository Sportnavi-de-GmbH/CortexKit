"use client";

// Pretty JSON (or wrapped text) with Copy and a "show all" for large payloads.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { BTN_GHOST, Kicker } from "./ui";

const LIMIT = 4000;

export function JsonView({ value, label }: { value: unknown; label: string }) {
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const isText = typeof value === "string";
  const full = isText ? (value as string) : JSON.stringify(value, null, 2);
  const empty = value === null || value === undefined || full === "{}" || full === "[]" || full === "";
  const shown = all || full.length <= LIMIT ? full : full.slice(0, LIMIT);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Kicker>{label}</Kicker>
        {!empty && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(full).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className={BTN_GHOST}
            aria-label={`Copy ${label}`}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-(--brand-green)" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {empty ? (
        <div className="rounded-xl border border-dashed border-(--border) px-3 py-2 text-xs text-(--fg-subtle)">Empty</div>
      ) : (
        <>
          <pre className={`max-h-96 overflow-auto rounded-xl border border-(--border) bg-(--bg) p-3 text-xs leading-relaxed ${isText ? "whitespace-pre-wrap font-body" : "font-mono"}`}>
            {shown}
          </pre>
          {full.length > LIMIT && !all && (
            <button type="button" onClick={() => setAll(true)} className="mt-1.5 text-xs font-medium text-(--fg) underline decoration-(--brand-green) decoration-2 underline-offset-[3px]">
              Show all ({Math.round(full.length / 1024)} KB)
            </button>
          )}
        </>
      )}
    </div>
  );
}
