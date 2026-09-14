"use client";

// A V3 partner answer: the agent's prose, with each recommended partner shown
// as a card that carries the model's own "why" sentence.
//
// Layout per task section:
//   bubble   — task label (multi-task only) + the intro line(s)
//   cards    — one per numbered recommendation, IN the answer's order
//   bubble   — any trailing prose (clarification question, deferred note)
//
// The card absorbs the bold "1. Name — Ort" heading so nothing is printed
// twice; the recommendation reason is the model's sentences for that partner,
// rendered in full (never clamped — it is the one thing a visitor reads to
// decide). Every structured field comes from the directory (lib/v3-answer.ts →
// V3Card); a field the directory lacks is simply not rendered.
//
// Visual rules (docs/design/WIDGET-DESIGN-GUIDELINES.md): card shell = the menu
// card, green is the single accent (an AI result, never a human hand-off),
// 48px logo tile with MapPin fallback, chips ≥ 32px with a 44px hit area.

import type { ReactNode } from "react";
import { ExternalLink, Globe, Mail, MapPin, Navigation, Phone } from "lucide-react";

import { formatAddress, pickCategories, type V3Item, type V3Recommendation, type V3Section } from "@/lib/v3-answer";
import { ContactLink, Logo } from "./PartnerCards";

export interface V3AnswerProps {
  sections: V3Section[];
  /** The chat bubble shell from NavioWidget — passed in so this file owns no bubble styling. */
  Bubble: (p: { children: ReactNode }) => ReactNode;
  /** The widget's markdown renderer (same link/bold styling as every other reply). */
  Markdown: (p: { text: string }) => ReactNode;
}

export function V3Answer({ sections, Bubble, Markdown }: V3AnswerProps) {
  const labelled = sections.filter((s) => s.label !== null).length > 1;
  return (
    <div className="flex flex-col gap-2.5">
      {sections.map((section, i) => (
        <Section key={`${section.label ?? "_"}-${i}`} section={section} showLabel={labelled} Bubble={Bubble} Markdown={Markdown} />
      ))}
    </div>
  );
}

function Section({ section, showLabel, Bubble, Markdown }: { section: V3Section; showLabel: boolean } & Pick<V3AnswerProps, "Bubble" | "Markdown">) {
  const hasBubble = (showLabel && section.label) || section.intro;
  return (
    <section aria-label={section.label ?? undefined} className="flex flex-col gap-2">
      {hasBubble && (
        <Bubble>
          {showLabel && section.label && (
            <p className="mb-1 font-headline text-[12px] font-semibold uppercase tracking-wide text-(--fg-subtle)">{section.label}</p>
          )}
          {section.intro && <Markdown text={section.intro} />}
        </Bubble>
      )}
      {section.items.length > 0 && (
        <ol className="flex max-w-[92%] flex-col gap-2" aria-label={section.label ? `Empfehlungen: ${section.label}` : "Empfehlungen"}>
          {section.items.map((item) => (
            <li key={item.rank}>
              <PartnerCard item={item} Markdown={Markdown} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** "Sportbox - Dortmund — Dortmund" → "Sportbox - Dortmund" (the location is rendered structured). */
function headingName(heading: string): string {
  const i = heading.lastIndexOf(" — ");
  return i > 0 ? heading.slice(0, i) : heading;
}

function PartnerCard({ item, Markdown }: { item: V3Item; Markdown: V3AnswerProps["Markdown"] }) {
  const rec = item.recommendation;
  const name = rec?.name ?? headingName(item.heading);
  const card = rec?.card;
  const categories = card ? pickCategories(card.tags, card.courses) : [];
  const address = card ? formatAddress(card.street, card.postalCode, rec) : null;
  const primaryHref = card?.websiteUrl ?? card?.mapsUrl ?? null;

  return (
    <article className="rounded-2xl border border-(--border) bg-(--surface) p-3.5 soft-shadow">
      <header className="flex items-start gap-3">
        <Logo url={card?.logoUrl ?? null} name={name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 font-headline text-[13px] font-semibold tabular-nums text-(--brand-green)" aria-hidden="true">
              {item.rank}
            </span>
            <h4 className="min-w-0 font-headline text-[15px] font-semibold leading-tight text-(--fg)">
              <span className="sr-only">Empfehlung {item.rank}: </span>
              {name}
            </h4>
          </div>
          {rec && <LocationLine rec={rec} />}
          {categories.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Angebot">
              {categories.map((c) => (
                <li key={c} className="rounded-full bg-(--accent-dim) px-2 py-0.5 text-[12px] font-medium leading-[1.4] text-(--fg)">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      {item.reason && (
        <div className="mt-3 border-l-2 border-(--brand-green) pl-3 text-[14px] leading-[1.6] text-(--fg)">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-(--fg-subtle)">Warum dieser Partner</p>
          <Markdown text={item.reason} />
        </div>
      )}

      {address && (
        <p className="mt-3 flex items-start gap-1.5 text-[13px] leading-[1.5] text-(--fg-muted)">
          <MapPin size={14} strokeWidth={2} className="mt-[3px] shrink-0 text-(--brand-green)" aria-hidden="true" />
          <span className="min-w-0 break-words">{address}</span>
        </p>
      )}

      {card && (card.websiteUrl || card.phone || card.email || card.mapsUrl) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {card.phone && (
            <ContactLink href={`tel:${card.phone.replace(/\s+/g, "")}`} icon={<Phone size={14} strokeWidth={2} />} external={false}>
              Anrufen
            </ContactLink>
          )}
          {card.email && (
            <ContactLink href={`mailto:${card.email}`} icon={<Mail size={14} strokeWidth={2} />} external={false}>
              E-Mail
            </ContactLink>
          )}
          {card.mapsUrl && (
            <ContactLink href={card.mapsUrl} icon={<Navigation size={14} strokeWidth={2} />} external>
              Route
            </ContactLink>
          )}
          {primaryHref && (
            <a
              href={primaryHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ outlineColor: "var(--brand-green)", borderRadius: "9999px" }}
              className="relative ml-auto inline-flex min-h-[32px] items-center gap-1.5 rounded-full bg-(--brand-green) px-3.5 text-[13px] font-semibold text-(--ink) transition-opacity after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 hover:opacity-90"
            >
              {card.websiteUrl ? <Globe size={14} strokeWidth={2} aria-hidden="true" /> : <Navigation size={14} strokeWidth={2} aria-hidden="true" />}
              {card.websiteUrl ? "Zum Partner" : "Route"}
              <ExternalLink size={12} strokeWidth={2} aria-hidden="true" className="opacity-70" />
            </a>
          )}
        </div>
      )}
    </article>
  );
}

/** "Dortmund" for the requested city, "Bochum · ca. 17 km entfernt" for a borrowed one. */
function LocationLine({ rec }: { rec: V3Recommendation }) {
  const nearby = rec.role === "nearby" && rec.distanceKm >= 1;
  return (
    <p className="mt-0.5 text-[13px] leading-snug text-(--fg-subtle)">
      {rec.city}
      {nearby && <span> · ca. {Math.round(rec.distanceKm)} km entfernt</span>}
    </p>
  );
}
