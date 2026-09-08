"use client";

// The data-freshness caveat under a partner answer that named real studios.
//
// WHY IT LOOKS DIFFERENT FROM EVERYTHING ELSE: the directory is scraped and
// best-effort, so opening hours, prices and offers can be stale. Saying that in
// the same grey prose as the recommendation makes it read as filler and it gets
// skipped. This is the only place in the widget that is meant to interrupt the
// reading flow, so it gets the semantic amber tokens from globals.css — the same
// axis the error alert already uses red on, NOT a third brand colour (green still
// means AI action, orange still means human hand-off).
//
// WHY THE COPY IS FIXED: the agent decides WHETHER the notice appears (it emits
// `[[notice:data]]` when it has named partners), never WHAT it says. A caveat that
// the model rewrites each turn is a caveat that can be softened away.
//
// The text is German because the whole widget chrome is — headers, menu cards and
// the chips all are. Only the agent's own prose follows the visitor's language.

import { AlertTriangle } from "lucide-react";

export function DataNotice() {
  return (
    <div
      // `role="note"`, not `alert`: nothing failed and nothing is urgent, so this
      // must not interrupt a screen reader mid-answer.
      role="note"
      className="mt-2 flex max-w-[92%] gap-2.5 rounded-2xl border px-3.5 py-2.5 text-[13px] leading-[1.55]"
      style={{
        background: "var(--warn-surface)",
        borderColor: "var(--warn-border)",
        color: "var(--warn-fg)",
      }}
    >
      <AlertTriangle
        size={15}
        strokeWidth={2.2}
        aria-hidden="true"
        className="mt-0.5 shrink-0"
        style={{ color: "var(--warn-icon)" }}
      />
      <p>
        <strong className="font-semibold">Hinweis:</strong> Informationen können gelegentlich
        veraltet oder noch nicht aktualisiert sein. Wir bemühen uns, unsere Daten stets aktuell zu
        halten, aber kleine Abweichungen können vorkommen. Für die aktuellsten Informationen
        empfehlen wir, das Studio direkt zu kontaktieren.
      </p>
    </div>
  );
}
