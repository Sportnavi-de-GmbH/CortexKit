"use client";

// Navio Plus menu (docs/design/NAVIO_PLUS_WIDGET_SPEC.md §6). Shown after consent:
// two option cards routing to the FAQ chat (green) or the Kontaktformular (orange).
// Presentational only — the parent (NavioWidget) owns navigation.

import { ArrowRight, Bot, Mail } from "lucide-react";

type CardProps = {
  icon: React.ReactNode;
  title: string;
  body: string;
  accent: "green" | "orange";
  onClick: () => void;
};

function OptionCard({ icon, title, body, accent, onClick }: CardProps) {
  const tile =
    accent === "green"
      ? "bg-(--brand-green)/15 text-(--brand-green)"
      : "bg-(--brand-orange)/15 text-(--brand-orange)";
  const hoverBorder =
    accent === "green" ? "hover:border-(--brand-green)/50" : "hover:border-(--brand-orange)/50";
  const arrowHover =
    accent === "green"
      ? "group-hover:bg-(--brand-green) group-hover:text-white"
      : "group-hover:bg-(--brand-orange) group-hover:text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex items-center gap-4 rounded-2xl border border-(--border) bg-(--surface) p-4 text-left soft-shadow transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.985] ${hoverBorder}`}
    >
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${tile}`} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-headline text-base font-semibold text-(--fg)">{title}</span>
        <span className="mt-0.5 block text-sm leading-snug text-(--fg-muted)">{body}</span>
      </span>
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--surface-muted) text-(--fg-subtle) transition-colors ${arrowHover}`}
        aria-hidden="true"
      >
        <ArrowRight size={16} strokeWidth={1.75} />
      </span>
    </button>
  );
}

export function NavioMenu({
  onSelectFaq,
  onSelectContact,
}: {
  onSelectFaq: () => void;
  onSelectContact: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-5">
      <p className="px-1 text-sm leading-relaxed text-(--fg-muted)">
        Wie können wir dir helfen? Wähle einfach aus 👇
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <OptionCard
          icon={<Bot size={24} strokeWidth={1.75} />}
          title="FAQ-Agent"
          body="Stell deine Frage – Navio antwortet sofort, rund um die Uhr."
          accent="green"
          onClick={onSelectFaq}
        />
        <OptionCard
          icon={<Mail size={24} strokeWidth={1.75} />}
          title="Kontaktformular"
          body="Schreib uns direkt – wir melden uns zeitnah bei dir zurück."
          accent="orange"
          onClick={onSelectContact}
        />
      </div>
      <p className="mt-5 px-1 text-xs leading-relaxed text-(--fg-subtle)">
        Navio Plus beantwortet Fragen rund um Sportnavi und leitet dich bei Bedarf an unser Team
        weiter.
      </p>
    </div>
  );
}
