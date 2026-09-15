"use client";

// components/monitoring/useDeleteFlow.tsx — shared delete flow for TraceList,
// AlertFeed and the trace-detail page: owns the confirm dialog, calls the
// DELETE endpoint, and refreshes the app after success (spec §5).
import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "./ConfirmDialog";
import { deleteBody } from "./selection";

const TITLE: Record<"trace" | "alert", string> = {
  trace: "Ausführung löschen",
  alert: "Meldung löschen",
};

export function useDeleteFlow(opts: {
  endpoint: string;
  kind: "trace" | "alert";
  onDone?: () => void;
  /** Refresh the CURRENT route after success (default true). Pass false when the caller
   *  navigates away in `onDone` — refreshing a route whose subject was just deleted renders
   *  its not-found tree and swallows the push (measured on the trace detail page). */
  refresh?: boolean;
}): {
  busy: boolean;
  error: string | null;
  detail: string | null;
  confirm: (ids: string[]) => void;
  dialog: ReactNode;
} {
  const router = useRouter();
  const [ids, setIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const confirm = useCallback((newIds: string[]) => {
    setIds(newIds);
    setError(null);
    setDetail(null);
  }, []);

  const cancel = useCallback(() => {
    if (busy) return;
    setIds(null);
    setError(null);
    setDetail(null);
  }, [busy]);

  const run = useCallback(async () => {
    if (!ids || ids.length === 0) return;
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      const r = await fetch(opts.endpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (r.ok) {
        setIds(null);
        if (opts.refresh !== false) router.refresh();
        window.dispatchEvent(new Event("navio:refresh"));
        opts.onDone?.();
      } else {
        const raw = await r.text().catch(() => "");
        setError("Löschen fehlgeschlagen – bitte erneut versuchen.");
        setDetail(raw || `HTTP ${r.status}`);
        // ids is kept as-is so the dialog stays open for a retry.
      }
    } catch (err) {
      setError("Löschen fehlgeschlagen – bitte erneut versuchen.");
      setDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [ids, opts, router]);

  const n = ids?.length ?? 0;
  const dialog: ReactNode = (
    <ConfirmDialog
      open={ids !== null}
      title={TITLE[opts.kind]}
      body={deleteBody(opts.kind, n)}
      busy={busy}
      error={error}
      detail={detail}
      onConfirm={() => void run()}
      onCancel={cancel}
    />
  );

  return { busy, error, detail, confirm, dialog };
}
