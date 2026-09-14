"use client";

// "Open full prompt": fetches the prompt content on demand (it is ~70 KB and
// replays on every FAQ turn, so the page never ships it by default).
import { useRef, useState } from "react";
import { FileText, X } from "lucide-react";

export function PromptDialog({ traceId, sizeChars }: { traceId: string; sizeChars: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function openDialog() {
    ref.current?.showModal();
    if (content !== null || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/monitoring/traces/${traceId}?prompt=1`);
      const j = (await res.json()) as { prompt?: { content?: string } };
      setContent(j.prompt?.content ?? "(prompt content unavailable)");
    } catch {
      setContent("(could not load the prompt)");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" onClick={openDialog} className="inline-flex items-center gap-1 text-xs font-medium text-(--brand-green) hover:underline">
        <FileText className="h-3.5 w-3.5" /> Open full prompt ({Math.round(sizeChars / 1024)} KB)
      </button>
      <dialog ref={ref} className="m-auto w-[min(90vw,900px)] rounded-2xl border border-(--border) bg-(--surface) p-0 text-(--fg) backdrop:bg-black/40">
        <div className="flex items-center justify-between border-b border-(--border) px-4 py-2">
          <span className="font-display text-sm font-semibold">System prompt</span>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-full p-1 hover:bg-(--surface-muted)">
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs">{busy ? "Loading…" : content}</pre>
      </dialog>
    </>
  );
}
