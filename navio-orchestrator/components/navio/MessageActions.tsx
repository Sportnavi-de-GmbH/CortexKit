"use client";

// The button row under a finished answer. A specialist asks for it by ending its
// reply with action markers; the master relays them verbatim (instructions.md R7),
// `parseMessageActions` turns them into ids and this renders them.
//
// Ported from kb-agent-langsmith-starter, adapted for the orchestrator's single
// chat surface:
//  - `partner` is an EXTERNAL LINK to sportnavi.de/studios (user decision,
//    2026-09-08 spec) — there is no partner screen; the chat itself is the
//    partner experience.
//  - `contact` is the only chip that navigates inside the widget. It takes the
//    `disabled` prop: while a turn is parked on an approval (`input.requested`),
//    navigating away would strand the ApprovalPrompt off-screen with a dead
//    composer. External links and the booking tab are side-effect-free and stay
//    clickable.
//
// Colour follows the widget's two-colour rule (docs/design/WIDGET-DESIGN-GUIDELINES.md):
// green is the AI/primary action, orange is the human hand-off, and a link off to
// sportnavi.de is neither, so it stays neutral. Do not add a third brand colour here.

import { ArrowUpRight, Calendar, HelpCircle, Info, Mail, MapPin, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { NavioActionId } from "../../lib/navio-actions";
import { ABOUT_URL, FAQ_URL, STUDIOS_URL } from "./links";

/** Where a chip goes: the contact screen, the booking tab, or out to sportnavi.de. */
type Target = { kind: "screen"; screen: "contact" } | { kind: "booking" } | { kind: "link"; href: string };

const ACTIONS: Record<
  NavioActionId,
  { label: string; icon: LucideIcon; accent: "green" | "orange" | "neutral"; target: Target }
> = {
  // Green (primary partner path) even though it leaves the widget — it is the
  // full, filterable studio search the prompts promise as "Partner finden".
  partner: {
    label: "Partner finden",
    icon: MapPin,
    accent: "green",
    target: { kind: "link", href: STUDIOS_URL },
  },
  studios: {
    label: "Studios durchsuchen",
    icon: Search,
    accent: "green",
    target: { kind: "link", href: STUDIOS_URL },
  },
  contact: {
    label: "Kontaktformular",
    icon: Mail,
    accent: "orange",
    target: { kind: "screen", screen: "contact" },
  },
  meeting: { label: "Termin buchen", icon: Calendar, accent: "orange", target: { kind: "booking" } },
  faq: {
    label: "FAQ",
    icon: HelpCircle,
    accent: "neutral",
    target: { kind: "link", href: FAQ_URL },
  },
  about: {
    label: "Über uns",
    icon: Info,
    accent: "neutral",
    target: { kind: "link", href: ABOUT_URL },
  },
};

// Literal class strings — Tailwind only sees classes it can read statically.
// Green fills (primary action); orange is a tint (how human-contact already reads);
// neutral matches the quick-reply pills.
const ACCENT: Record<"green" | "orange" | "neutral", { chip: string; outline: string }> = {
  green: {
    chip: "border-(--brand-green) bg-(--brand-green) text-(--ink) hover:brightness-95",
    outline: "var(--brand-green)",
  },
  orange: {
    chip: "border-(--brand-orange)/45 bg-(--brand-orange)/15 text-(--fg) hover:bg-(--brand-orange)/25 hover:border-(--brand-orange)",
    outline: "var(--brand-orange)",
  },
  neutral: {
    chip: "border-(--border) bg-(--surface) text-(--fg-muted) hover:border-(--fg)/25 hover:bg-(--surface-muted) hover:text-(--fg)",
    outline: "var(--brand-green)",
  },
};

// The `after:` block is the 44px touch-target pattern used by FeedbackControls and
// HeaderBtn: the chip stays visually compact while staying tappable.
const CHIP_BASE =
  "relative inline-flex min-h-[34px] items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-[background-color,border-color,filter] " +
  "after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

export function MessageActions({
  actions,
  onScreen,
  bookingUrl,
  disabled = false,
}: {
  actions: NavioActionId[];
  onScreen: (screen: "contact") => void;
  /** Null when NEXT_PUBLIC_BOOKING_URL is unset — the meeting chip is then dropped. */
  bookingUrl: string | null;
  /** True while a turn is parked/busy — disables the screen-navigating chip only. */
  disabled?: boolean;
}) {
  // Drop chips that have nowhere to go, then bail out rather than render an empty row.
  const usable = actions.filter((id) => ACTIONS[id].target.kind !== "booking" || bookingUrl);
  if (usable.length === 0) return null;

  return (
    <div className="mt-2 max-w-[92%]">
      {/* Fixed lead-in (owner requirement 2026-09-08): every answer must SAY that
          the Sportnavi team is one tap away — and a fixed UI line delivers
          "always" where a prompt rule cannot. German like the rest of the chrome;
          only the agent's prose follows the visitor's language. */}
      <p className="mb-1.5 px-0.5 text-[11px] leading-snug text-(--fg-subtle)">
        Du möchtest das Sportnavi-Team erreichen oder mehr entdecken? Nutze einfach diese Buttons:
      </p>
      <div className="flex flex-wrap gap-2">
      {usable.map((id) => {
        const { label, icon: Icon, accent, target } = ACTIONS[id];
        const { chip, outline } = ACCENT[accent];
        // globals.css carries an UNLAYERED button:focus-visible rule that beats Tailwind
        // utilities, so the ring colour has to be inline.
        const style = { outlineColor: outline };

        if (target.kind === "link") {
          return (
            <a
              key={id}
              href={target.href}
              target="_blank"
              rel="noreferrer"
              className={`${CHIP_BASE} ${chip}`}
              style={style}
            >
              <Icon size={14} strokeWidth={2} aria-hidden="true" />
              {label}
              <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" className="opacity-60" />
            </a>
          );
        }

        const gated = target.kind === "screen" && disabled;
        return (
          <button
            key={id}
            type="button"
            disabled={gated}
            onClick={() =>
              target.kind === "booking"
                ? window.open(bookingUrl!, "_blank", "noopener,noreferrer")
                : onScreen(target.screen)
            }
            className={`${CHIP_BASE} ${chip} disabled:cursor-not-allowed disabled:opacity-50`}
            style={style}
          >
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            {label}
          </button>
        );
      })}
      </div>
    </div>
  );
}
