"use client";

// Single-trace delete button — the client island for the trace detail page
// (text button "Löschen" in PageHeader.actions) and the session view (per-turn
// icon button). Reuses the shared confirm dialog via useDeleteFlow (spec §5).
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { BTN_DANGER_SM, ICON_BTN } from "./ui";
import { useDeleteFlow } from "./useDeleteFlow";

export function DeleteTraceButton({
  id,
  size = "md",
  afterDelete,
  label = "Löschen",
}: {
  id: string;
  size?: "sm" | "md";
  /** "overview": leave the (now missing) detail page for /monitoring. "refresh": stay — the hook already refreshed. */
  afterDelete: "overview" | "refresh";
  label?: string;
}) {
  const router = useRouter();
  const del = useDeleteFlow({
    endpoint: "/api/monitoring/traces",
    kind: "trace",
    refresh: afterDelete !== "overview",
    onDone: () => {
      if (afterDelete === "overview") {
        router.push("/monitoring");
        router.refresh();
      }
    },
  });

  return (
    <>
      {size === "sm" ? (
        <button
          type="button"
          className={`${ICON_BTN} h-8 w-8 hover:text-(--red)`}
          aria-label="Ausführung löschen"
          title="Ausführung löschen"
          disabled={del.busy}
          onClick={() => del.confirm([id])}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <button type="button" className={BTN_DANGER_SM} disabled={del.busy} onClick={() => del.confirm([id])}>
          <Trash2 className="h-4 w-4" aria-hidden />
          {label}
        </button>
      )}
      {del.dialog}
    </>
  );
}
