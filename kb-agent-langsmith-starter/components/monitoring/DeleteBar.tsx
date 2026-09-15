"use client";

// Sticky bottom bar shown while at least one row is selected. Shared by
// TraceList (trace rows) and AlertFeed (alert rows) — spec §5.
import { BTN_GHOST, CARD } from "./ui";

const BTN_DANGER_SM =
  "inline-flex h-9 items-center gap-1.5 rounded-full bg-(--red) px-3.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";

export function DeleteBar({
  count,
  busy = false,
  onClear,
  onDelete,
}: {
  count: number;
  busy?: boolean;
  onClear: () => void;
  onDelete: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className={`fixed inset-x-4 bottom-4 z-30 mx-auto max-w-3xl ${CARD} soft-shadow-lg`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-medium text-(--fg)">{count} ausgewählt</span>
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_GHOST} onClick={onClear} disabled={busy}>
            Auswahl aufheben
          </button>
          <button type="button" className={BTN_DANGER_SM} onClick={onDelete} disabled={busy}>
            Löschen
          </button>
        </div>
      </div>
    </div>
  );
}
