"use client";

// "Open full prompt": fetches the prompt content on demand (it is ~70 KB and
// replays on every FAQ turn, so the page never ships it by default).
import { useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { BTN_SECONDARY, ICON_BTN } from "./ui";

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
      <button type="button" onClick={openDialog} className={`${BTN_SECONDARY} mt-2 w-full`}>
        <FileText className="h-3.5 w-3.5" aria-hidden /> Open full prompt ({Math.round(sizeChars / 1024)} KB)
      </button>
      <dialog
        ref={ref}
        aria-label="System prompt"
        className="m-auto w-[min(92vw,960px)] rounded-2xl border border-(--border) bg-(--surface) p-0 text-(--fg) soft-shadow-lg backdrop:bg-(--ink)/50 backdrop:backdrop-blur-sm"
      >
        <div className="flex items-center justify-between gap-3 border-b border-(--border) px-5 py-3">
          <div>
            <div className="font-display text-[15px] font-semibold">System prompt</div>
            <div className="text-xs text-(--fg-muted)">The exact knowledge base the model saw on this turn.</div>
          </div>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className={ICON_BTN}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed">{busy ? "Loading…" : content}</pre>
      </dialog>
    </>
  );
}
