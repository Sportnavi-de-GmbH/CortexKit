"use client";

// Shared confirm dialog for destructive actions (trace / alert delete).
// Native <dialog> so focus-trap and Escape-to-close come for free; the
// element is only ever shown via showModal()/close(), driven by `open`.
import { useEffect, useRef } from "react";
import { BTN_SECONDARY } from "./ui";

const BTN_DANGER = "inline-flex h-10 items-center rounded-full bg-(--red) px-4 font-display text-sm font-semibold text-white";

export function ConfirmDialog({
  open,
  title,
  body,
  busy = false,
  error = null,
  detail = null,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  busy?: boolean;
  error?: string | null;
  detail?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-dialog-title"
      className="m-auto w-[min(92vw,420px)] rounded-2xl border border-(--border) bg-(--surface) p-0 text-(--fg) soft-shadow-lg backdrop:bg-(--ink)/50 backdrop:backdrop-blur-sm"
      onCancel={(e) => {
        // native Escape handling — keep state in sync instead of preventing it
        e.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <div className="p-5">
        <h2 id="confirm-dialog-title" className="font-display text-[15px] font-semibold leading-tight text-(--fg)">
          {title}
        </h2>
        <p className="mt-2 text-sm text-(--fg-muted)">{body}</p>
        {error && (
          <div className="mt-3 text-xs text-(--red)">
            <p>{error}</p>
            {detail && (
              <details className="mt-1 text-(--fg-subtle)">
                <summary className="cursor-pointer select-none">Details</summary>
                <p className="mt-1 break-words">{detail}</p>
              </details>
            )}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={BTN_SECONDARY} onClick={onCancel} disabled={busy}>
            Abbrechen
          </button>
          <button type="button" className={BTN_DANGER} onClick={onConfirm} disabled={busy}>
            Endgültig löschen
          </button>
        </div>
      </div>
    </dialog>
  );
}
