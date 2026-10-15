"use client";

// The "Quellen" block at the foot of a FAQ answer: the knowledge-base sources the
// agent cited with `[[source:URL]]` (prompt v4 §7A).
//
// WHY INSIDE THE BUBBLE: a source belongs to the answer it backs, so it sits under
// that answer's text, separated by a hairline, rather than out among the action
// chips (which are next steps, not evidence).
//
// WHY THE URLS ARE TRUSTED: parseMessageActions only passes URLs the knowledge base
// itself cites (lib/kb-sources.ts). A made-up URL never reaches this component.
//
// Links use the same treatment as links in the answer text — ink with a thick
// green underline (Markdown in NavioWidget) — so they read as links without
// spending green on body text or adding a colour. Each opens in a new tab, like
// every outbound link: the widget lives in an iframe.

import { ArrowUpRight } from "lucide-react";

/** `https://www.sportnavi.de/faq/mitglieder-nutzung/` → `sportnavi.de/faq/mitglieder-nutzung` */
export function sourceLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

export function SourceList({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-3 border-t border-(--border) pt-2.5">
      <p className="text-[11px] font-semibold tracking-[0.12em] text-(--fg-subtle) uppercase">
        <span lang="de">Quellen</span>
        <span aria-hidden="true"> · </span>
        <span lang="en" className="font-medium opacity-80">
          Sources
        </span>
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {sources.map((url) => (
          <li key={url} className="flex items-start gap-1.5 text-[13px] leading-snug">
            <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" className="mt-[3px] shrink-0 text-(--fg-subtle)" />
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="font-medium break-all text-(--fg) decoration-(--brand-green) decoration-2 underline underline-offset-[3px] transition-[text-decoration-color,background-color] hover:bg-(--brand-green)/15 hover:decoration-(--fg)"
            >
              {sourceLabel(url)}
              <span className="sr-only"> (öffnet in neuem Tab · opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
