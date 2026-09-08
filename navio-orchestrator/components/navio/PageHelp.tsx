"use client";

// Page-specific help ("Was kann ich hier tun?") — the ⓘ in the header opens a
// small manual for the CURRENT screen only. One mechanism, one look, three
// content entries; the copy explains nothing but the page the visitor is on.
//
// Bilingual by the widget's existing convention: German first at full
// contrast, English beneath it muted (see INTRO_CHAT / the consent copy).
// Neutral surface colors only — green stays reserved for AI actions and
// orange for human hand-off (docs/design/WIDGET-DESIGN-GUIDELINES.md).

import { useEffect } from "react";
import { ArrowRight, X } from "lucide-react";

import { PAGE_HELP, type HelpScreen } from "./pageHelpContent";

export { PAGE_HELP, type HelpScreen, type PageHelpEntry } from "./pageHelpContent";

/**
 * The overlay itself. Rendered by NavioWidget directly under the header while
 * open; the parent owns the open state so it can also close it on any screen
 * change. Dismiss: ✕, Escape, or clicking the dimmed backdrop.
 */
export function PageHelpOverlay({
  screen,
  onClose,
  onOpenAbout,
}: {
  screen: HelpScreen;
  onClose: () => void;
  /** Menu only: keeps the existing "Über Navio Plus" screen reachable, since
   *  this overlay replaced the ⓘ that used to navigate straight to it. */
  onOpenAbout?: () => void;
}) {
  const help = PAGE_HELP[screen];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Backdrop below the header: clicking anywhere outside the card closes.
    <div
      className="absolute inset-x-0 top-0 bottom-0 z-20 bg-black/25"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={help.title}
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-3 w-[calc(100%-24px)] max-w-[452px] rounded-2xl border border-(--border) bg-(--surface) p-4 shadow-lg"
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <h3 className="font-headline text-sm font-semibold text-(--fg)">{help.title}</h3>
          <button
            type="button"
            aria-label="Hilfe schließen"
            onClick={onClose}
            className="relative -mt-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-(--surface-muted) hover:text-(--fg)"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-(--fg)">
          {help.de.map((line, i) => (
            <p key={`de-${i}`}>{line}</p>
          ))}
        </div>
        <div className="mt-2.5 flex flex-col gap-1 border-t border-(--border) pt-2.5 text-xs leading-relaxed text-(--fg-muted)">
          {help.en.map((line, i) => (
            <p key={`en-${i}`}>{line}</p>
          ))}
        </div>

        {onOpenAbout && (
          <button
            type="button"
            onClick={onOpenAbout}
            className="mt-3 inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-(--border) px-3 py-1 text-xs font-medium text-(--fg-muted) transition-colors hover:bg-(--surface-muted) hover:text-(--fg)"
          >
            Mehr über Navio Plus · About Navio Plus
            <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
