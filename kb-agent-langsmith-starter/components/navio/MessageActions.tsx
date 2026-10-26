"use client";

// The button row under a finished FAQ answer. The agent asks for it by ending its
// reply with action markers (`agent/prompts/instructions-v2.md` §7); `parseMessageActions`
// turns those into ids and this renders them.
//
// Colour follows the widget's two-colour rule (docs/design/WIDGET-DESIGN-GUIDELINES.md):
// green is the AI action, orange is the human hand-off, and a link off to sportnavi.de
// is neither, so it stays neutral. Do not add a third brand colour here.
//
// Presentational only — NavioWidget owns navigation.
// The "partner" and "meeting" chips were removed with those features; resolveActions
// never passes them here (lib/navio-actions.ts HIDDEN_ACTION_IDS).

import { ArrowUpRight, Bot, HelpCircle, Info, Mail, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { VisibleActionId } from "../../lib/navio-actions";
import { ABOUT_URL, CONTACT_URL, FAQ_URL, STUDIOS_URL } from "./links";

/** Where a chip goes: back into the widget, or out to sportnavi.de. */
type Target = { kind: "screen"; screen: "chat" | "partner" | "contact" } | { kind: "link"; href: string };

const ACTIONS: Record<
  VisibleActionId,
  { label: string; icon: LucideIcon; accent: "green" | "orange" | "neutral"; target: Target }
> = {
  // The Partner screen's hand-off back to the FAQ agent. Green: it is an AI agent.
  "faq-agent": {
    label: "FAQ-Agent",
    icon: Bot,
    accent: "green",
    target: { kind: "screen", screen: "chat" },
  },
  // Green rather than neutral: this is the Partner screen's primary next step
  // (a full, filterable search), not a footnote link like the FAQ page.
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
    target: { kind: "link", href: CONTACT_URL },
  },
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
// Green fills (it is the primary in-widget action); orange is a tint, so the
// human hand-off stays quiet; neutral matches the quick-reply pills.
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
}: {
  actions: VisibleActionId[];
  onScreen: (screen: "chat" | "partner" | "contact") => void;
}) {
  // Bail out rather than render an empty row.
  if (actions.length === 0) return null;

  return (
    <div className="mt-2 flex max-w-[92%] flex-wrap gap-2">
      {actions.map((id) => {
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

        return (
          <button
            key={id}
            type="button"
            onClick={() => onScreen(target.screen)}
            className={`${CHIP_BASE} ${chip}`}
            style={style}
          >
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
