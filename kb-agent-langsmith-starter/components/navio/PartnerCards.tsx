"use client";

// Partner cards under a Partner-Finder answer.
//
// The agent's prose is the short intro (opening line, coverage, one line per
// partner); these cards are the detail layer — logo, location, description,
// address, contact and website — built from the structured tool result the
// agent streams alongside its text (lib/partner-cards.ts). Nothing here is
// written by the model, so nothing here can be invented.
//
// Visual rules (docs/design/WIDGET-DESIGN-GUIDELINES.md): the card shell is the
// menu card's (NavioMenu.tsx), green is the only accent — a partner is an AI
// result, not a human hand-off — and the logo tile is a FIXED 48px box so an
// image that lands after the auto-scroll never shifts the layout. A missing or
// broken logo shows a MapPin glyph instead; most partners have no logo, so that
// is the normal case, not an error state.
//
// Chrome text is German like the rest of the widget; the data is the partner's.

import { useEffect, useRef, useState } from "react";

import { Clock, Globe, Mail, MapPin, Phone } from "lucide-react";

import type { PartnerCardData, PartnerCardGroup } from "@/lib/partner-cards";

/** Cards shown per request before "Alle N anzeigen". */
const INITIAL_VISIBLE = 5;
const MAX_TAGS = 4;

export function PartnerCards({ groups }: { groups: PartnerCardGroup[] }) {
  const showHeadings = groups.length > 1;
  return (
    <div className="mt-2 flex max-w-[92%] flex-col gap-3">
      {groups.map((group) => (
        <Group key={group.label} group={group} showHeading={showHeadings} />
      ))}
    </div>
  );
}

function Group({ group, showHeading }: { group: PartnerCardGroup; showHeading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.cards.length - INITIAL_VISIBLE;
  const visible = expanded ? group.cards : group.cards.slice(0, INITIAL_VISIBLE);

  return (
    <section aria-label={group.label} className="flex flex-col gap-2">
      {showHeading && (
        <h3 className="px-1 font-headline text-[13px] font-semibold uppercase tracking-wide text-(--fg-subtle)">
          {group.label}
        </h3>
      )}
      <ol className="flex flex-col gap-2">
        {visible.map((card) => (
          <li key={card.partnerId}>
            <Card card={card} />
          </li>
        ))}
      </ol>
      {hidden > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          // globals.css has an unlayered `button:focus-visible` rule; inline
          // style is what wins (see NavioMenu.tsx).
          style={{ outlineColor: "var(--brand-green)", borderRadius: "9999px" }}
          className="min-h-[36px] self-start rounded-full border border-(--border) bg-(--surface) px-3.5 text-[13px] font-medium text-(--fg-muted) transition-colors hover:border-(--brand-green) hover:text-(--fg)"
        >
          Alle {group.cards.length} anzeigen
        </button>
      )}
    </section>
  );
}

function Card({ card }: { card: PartnerCardData }) {
  const address = [card.street, [card.postalCode, card.city].filter(Boolean).join(" ")]
    .filter((s) => s && s.length > 0)
    .join(", ");
  const hasContact = card.phone || card.email || card.websiteUrl;

  return (
    <article className="flex gap-3 rounded-2xl border border-(--border) bg-(--surface) p-3 soft-shadow">
      <Logo url={card.logoUrl} name={card.name} />
      <div className="min-w-0 flex-1">
        <h4 className="font-headline text-[15px] font-semibold leading-tight text-(--fg)">{card.name}</h4>
        <LocationLine card={card} />

        {card.tags.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Angebot">
            {card.tags.slice(0, MAX_TAGS).map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-(--accent-dim) px-2 py-0.5 text-[12px] font-medium leading-[1.4] text-(--fg)"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}

        {card.description && (
          <p className="mt-2 line-clamp-3 text-[13px] leading-[1.55] text-(--fg-muted)">{card.description}</p>
        )}

        {(card.openingHours || address) && (
          <dl className="mt-2 flex flex-col gap-1 text-[13px] leading-[1.5] text-(--fg-muted)">
            {card.openingHours && (
              <Detail icon={<Clock size={14} strokeWidth={2} />} label="Öffnungszeiten">
                {card.openingHours}
              </Detail>
            )}
            {address && (
              <Detail icon={<MapPin size={14} strokeWidth={2} />} label="Adresse">
                {address}
              </Detail>
            )}
          </dl>
        )}

        {hasContact && (
          <div className="mt-2 flex flex-wrap gap-1.5">
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
            {card.websiteUrl && (
              <ContactLink href={card.websiteUrl} icon={<Globe size={14} strokeWidth={2} />} external>
                Website
              </ContactLink>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** "Bochum" for a requested-city hit, "Herne · ~8 km entfernt" for a borrowed one. */
function LocationLine({ card }: { card: PartnerCardData }) {
  const city = card.city ?? card.sourceCity;
  if (!city) return null;
  const nearby = card.source === "nearby" && card.distanceKm > 0;
  return (
    <p className="mt-0.5 text-[13px] leading-snug text-(--fg-subtle)">
      {city}
      {nearby && <span> · ~{Math.round(card.distanceKm)} km entfernt</span>}
    </p>
  );
}

function Detail({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <dt className="mt-[3px] shrink-0 text-(--brand-green)" aria-label={label}>
        {icon}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function ContactLink({
  href,
  icon,
  external,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  external: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      style={{ outlineColor: "var(--brand-green)", borderRadius: "9999px" }}
      // `after:` pseudo-element widens the hit area to 44px without growing the chip
      // (same trick as MessageActions.tsx).
      className="relative inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-(--border) bg-(--surface) px-3 text-[13px] font-medium text-(--fg) transition-colors after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 hover:border-(--brand-green) hover:bg-(--accent-dim)"
    >
      <span className="text-(--brand-green)" aria-hidden="true">
        {icon}
      </span>
      {children}
    </a>
  );
}

/**
 * 48px logo tile. Pinned size, lazy-loaded, and a MapPin fallback when there
 * is no logo or the image fails. The mount-time `complete && naturalWidth === 0`
 * check mirrors NavioLogo.tsx: a failed load can finish before React attaches
 * `onError`.
 */
export function Logo({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, [url]);

  if (!url || failed) {
    return (
      <span
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-(--accent-dim) text-(--brand-green)"
        aria-hidden="true"
      >
        <MapPin size={22} strokeWidth={1.75} />
      </span>
    );
  }

  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-(--border) bg-(--surface)">
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary partner hosts; next/image needs an allowlist. */}
      <img
        ref={imgRef}
        src={url}
        alt={`Logo ${name}`}
        width={48}
        height={48}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain p-1"
        draggable={false}
      />
    </span>
  );
}
