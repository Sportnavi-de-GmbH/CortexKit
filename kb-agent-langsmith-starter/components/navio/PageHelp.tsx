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
import { ArrowRight, ArrowUpRight, X } from "lucide-react";

import { SITE_LINKS } from "./links";
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
  showSiteLinks = false,
  onOpenAbout,
}: {
  screen: HelpScreen;
  onClose: () => void;
  /** FAQ chat only: the sportnavi.de links that lived on the removed menu screen. */
  showSiteLinks?: boolean;
  /** FAQ chat only: keeps the "Über Navio Plus" screen reachable. */
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
        // Scrolls inside the panel: with the link row it is taller than the
        // 560px floating widget, and its last rows must stay reachable.
        className="mx-auto mt-3 max-h-[calc(100%-24px)] w-[calc(100%-24px)] max-w-[452px] overflow-y-auto overscroll-contain rounded-2xl border border-(--border) bg-(--surface) p-4 shadow-lg"
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

        {showSiteLinks && <SiteLinkPills />}

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

/**
 * The general sportnavi.de links (FAQ, Studios, Kontakt, Über uns, Datenschutz).
 * They LEAVE the widget, so each opens in a new tab — the widget lives in an
 * iframe, and navigating in place would replace the chat, not the host page.
 */
function SiteLinkPills() {
  return (
    <nav aria-label="Mehr auf sportnavi.de · More on sportnavi.de" className="mt-3 border-t border-(--border) pt-3">
      <h4 className="text-[11px] font-semibold tracking-[0.14em] text-(--fg-subtle) uppercase">
        <span lang="de">Nützliche Links</span>
        <span aria-hidden="true"> · </span>
        <span lang="en" className="font-medium opacity-80">
          Useful links
        </span>
      </h4>
      <ul className="mt-2 flex flex-wrap gap-2">
        {SITE_LINKS.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-(--border) bg-(--surface) px-3 py-1.5 text-[13px] font-medium text-(--fg-muted) transition-colors hover:border-(--fg)/25 hover:bg-(--surface-muted) hover:text-(--fg) focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span lang="de">{link.label}</span>
              {link.en && (
                <span lang="en" className="font-normal text-(--fg-subtle)">
                  <span aria-hidden="true">· </span>
                  {link.en}
                </span>
              )}
              <ArrowUpRight size={13} strokeWidth={2} className="text-(--fg-subtle)" aria-hidden="true" />
              <span className="sr-only">(öffnet in neuem Tab · opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
