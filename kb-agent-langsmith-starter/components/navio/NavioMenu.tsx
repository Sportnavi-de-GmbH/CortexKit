"use client";

// Navio Plus menu (docs/design/NAVIO_PLUS_WIDGET_SPEC.md §6) — the widget's home
// screen, shown after consent. Presentational only; NavioWidget owns navigation.
//
// Structure follows the "priority grid" resolved in Stitch: the two green agent
// options are full rows with descriptions, the two orange human-contact options
// collapse into a compact 2-up grid. That does three things at once — it expresses
// primary vs secondary in LAYOUT rather than in colour alone, it stops the menu
// reading as four near-identical boxes, and it is what makes all four options fit
// the 380x560 panel without scrolling.
//
// Every label is bilingual, German first and English subordinate — the same
// two-level pattern the chat intro and the info panel use ("Über Navio Plus" /
// "About Navio Plus"): the widget is embedded on a German site, but many
// visitors read English. Compact labels (tier headings, link chips) join both
// with " · ", the way the footer's "Datenschutz · Privacy Policy" already does.

import { ArrowUpRight, ChevronRight, Bot, Calendar, Mail, MapPin } from "lucide-react";
import { SITE_LINKS } from "./links";

type Accent = "green" | "orange";

// Full literal class strings — Tailwind only sees classes it can read statically.
// Glyphs sit on brand fills as ink (#1a1a1a): green and orange are too light to
// carry a white glyph at the 3:1 non-text contrast floor.
const ACCENT: Record<
  Accent,
  {
    tile: string;
    bar: string;
    hover: string;
    chevron: string;
    /** focus-ring colour, applied inline — see cardStyle */
    ring: string;
  }
> = {
  green: {
    // Solid fill: the primary path carries the brand.
    tile: "bg-(--brand-green) text-(--ink)",
    bar: "bg-(--brand-green)",
    hover:
      "hover:border-(--brand-green)/60 hover:bg-(--brand-green)/5 focus-visible:border-(--brand-green)/60 focus-visible:bg-(--brand-green)/5",
    chevron:
      "group-hover:bg-(--brand-green) group-hover:text-(--ink) group-focus-visible:bg-(--brand-green) group-focus-visible:text-(--ink)",
    ring: "var(--brand-green)",
  },
  orange: {
    // Tint, not solid: the hand-off path stays quiet without looking disabled.
    // The glyph is NOT orange — #EC6607 on its own 20% tint is ~2.9:1, under the 3:1
    // non-text floor. It is also not ink: a 20% orange tint over #1a1a1a is a dark
    // brown, and an ink glyph vanishes on it in dark mode. `--fg` is the only choice
    // that clears contrast in BOTH themes, because it flips with the surface.
    tile: "bg-(--brand-orange)/20 text-(--fg)",
    bar: "bg-(--brand-orange)",
    hover:
      "hover:border-(--brand-orange)/60 hover:bg-(--brand-orange)/5 focus-visible:border-(--brand-orange)/60 focus-visible:bg-(--brand-orange)/5",
    chevron:
      "group-hover:bg-(--brand-orange) group-hover:text-(--ink) group-focus-visible:bg-(--brand-orange) group-focus-visible:text-(--ink)",
    ring: "var(--brand-orange)",
  },
};

// globals.css carries an UNLAYERED `button:focus-visible` rule (green outline,
// border-radius 6px) that beats every Tailwind utility, since utilities live in
// @layer utilities. Inline styles are the one thing that outranks it — without this
// the orange cards get a green ring and every focused card squares off.
const cardStyle = (accent: Accent) => ({
  outlineColor: ACCENT[accent].ring,
  borderRadius: "1rem",
});

const CARD_BASE =
  "group relative flex overflow-hidden rounded-2xl border border-(--border) bg-(--surface) text-left soft-shadow transition-[transform,border-color,background-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:soft-shadow-lg active:translate-y-0 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2";

/** The accent rail — the one thing that moves, scaling in from the card's edge. */
function Rail({ accent }: { accent: Accent }) {
  return (
    <span
      className={`absolute top-2.5 bottom-2.5 left-0 w-1 scale-y-0 rounded-r-full transition-transform duration-200 group-hover:scale-y-100 group-focus-visible:scale-y-100 ${ACCENT[accent].bar}`}
      aria-hidden="true"
    />
  );
}

/** Primary option: full row — icon, title, description (DE + EN), chevron. */
function PrimaryRow({
  icon,
  title,
  titleEn,
  body,
  bodyEn,
  accent,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  /** Omit when identical to `title`. */
  titleEn?: string;
  body: string;
  bodyEn: string;
  accent: Accent;
  onClick: () => void;
}) {
  const a = ACCENT[accent];
  return (
    <button
      type="button"
      onClick={onClick}
      style={cardStyle(accent)}
      className={`${CARD_BASE} w-full items-center gap-3 p-3 ${a.hover}`}
    >
      <Rail accent={accent} />
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${a.tile}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-headline text-[15px] font-semibold leading-tight text-(--fg)" lang="de">
          {title}
          {titleEn && (
            <span className="ml-1.5 text-[12px] font-medium text-(--fg-subtle)" lang="en">
              <span aria-hidden="true">·&nbsp;</span>
              {titleEn}
            </span>
          )}
        </span>
        <span className="mt-1 block text-[13px] leading-snug text-(--fg-muted)" lang="de">{body}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-(--fg-subtle)" lang="en">{bodyEn}</span>
      </span>
      <span
        className={`hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--surface-muted) text-(--fg-subtle) transition-colors duration-200 min-[360px]:flex ${a.chevron}`}
        aria-hidden="true"
      >
        <ChevronRight size={16} strokeWidth={2} />
      </span>
    </button>
  );
}

/** Secondary option: compact tile — icon over label (DE, EN beneath), no description. */
function SecondaryTile({
  icon,
  title,
  titleEn,
  accent,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  titleEn: string;
  accent: Accent;
  onClick: () => void;
}) {
  const a = ACCENT[accent];
  return (
    <button
      type="button"
      onClick={onClick}
      style={cardStyle(accent)}
      className={`${CARD_BASE} min-h-[76px] flex-col justify-center gap-2 px-3 py-3 ${a.hover}`}
    >
      <Rail accent={accent} />
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${a.tile}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="font-headline text-[13px] font-semibold leading-tight text-(--fg)" lang="de">
        {title}
      </span>
      <span className="-mt-1 text-[11px] leading-tight text-(--fg-subtle)" lang="en">
        {titleEn}
      </span>
    </button>
  );
}

function TierLabel({ de, en }: { de: string; en: string }) {
  return (
    <h2 className="px-1 text-[11px] font-semibold tracking-[0.14em] text-(--fg-subtle) uppercase">
      <span lang="de">{de}</span>
      <span aria-hidden="true"> · </span>
      <span lang="en" className="font-medium opacity-80">
        {en}
      </span>
    </h2>
  );
}

export function NavioMenu({
  onSelectFaq,
  onSelectPartner,
  onSelectContact,
  onSelectMeeting,
}: {
  onSelectFaq: () => void;
  onSelectPartner: () => void;
  onSelectContact: () => void;
  // Undefined when NEXT_PUBLIC_BOOKING_URL is unset — the tile is hidden rather
  // than shown disabled, same as "Partner finden" degrading when its host is unset.
  onSelectMeeting?: () => void;
}) {
  return (
    <nav aria-label="Navio Plus Hauptmenü · main menu" className="flex-1 overflow-y-auto px-4 pt-4 pb-4">
      {/* Readable measure. The widget is 380px in its desktop iframe, but launcher.js
          switches to a full-screen iframe under 480px — including landscape phones,
          where an unconstrained list would stretch to 740px+ per row. */}
      <div className="mx-auto w-full max-w-[420px]">
        <h1 className="px-1 font-headline text-xl font-semibold leading-tight tracking-[-0.01em] text-(--fg)" lang="de">
          Wie können wir dir helfen?
        </h1>
        <p className="mt-0.5 px-1 text-[13px] leading-snug text-(--fg-subtle)" lang="en">
          How can we help you?
        </p>

        <div className="mt-5">
          <TierLabel de="Mit Navio chatten" en="Chat with Navio" />
          <div className="mt-2 flex flex-col gap-2">
            <PrimaryRow
              icon={<Bot size={22} strokeWidth={1.75} />}
              title="FAQ-Agent"
              body="Fragen zu Tarifen, Check-in & Co. – sofort beantwortet."
              bodyEn="Questions about plans, check-in & more — answered instantly."
              accent="green"
              onClick={onSelectFaq}
            />
            <PrimaryRow
              icon={<MapPin size={22} strokeWidth={1.75} />}
              title="Partner finden"
              titleEn="Find partners"
              body="Studios & Kurse in deiner Nähe – sag Stadt und Sportart."
              bodyEn="Studios & classes near you — just name a city and a sport."
              accent="green"
              onClick={onSelectPartner}
            />
          </div>
        </div>

        <div className="mt-5">
          <TierLabel de="Direkter Kontakt" en="Direct contact" />
          <div className={`mt-2 grid gap-2 ${onSelectMeeting ? "grid-cols-2" : "grid-cols-1"}`}>
            <SecondaryTile
              icon={<Mail size={20} strokeWidth={1.75} />}
              title="Kontaktformular"
              titleEn="Contact form"
              accent="orange"
              onClick={onSelectContact}
            />
            {onSelectMeeting && (
              <SecondaryTile
                icon={<Calendar size={20} strokeWidth={1.75} />}
                title="Termin buchen"
                titleEn="Book a meeting"
                accent="orange"
                onClick={onSelectMeeting}
              />
            )}
          </div>
        </div>

        <div className="mt-6 border-t border-(--border) pt-4">
          <TierLabel de="Mehr auf sportnavi.de" en="More on sportnavi.de" />
          <ul className="mt-2.5 flex flex-wrap gap-2">
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
        </div>
      </div>
    </nav>
  );
}
