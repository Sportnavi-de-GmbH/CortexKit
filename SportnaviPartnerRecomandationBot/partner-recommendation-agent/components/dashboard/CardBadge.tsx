"use client";

const VARIANT_STYLE = {
  mint: "bg-teal-600 shadow-teal-200",
  peach: "bg-orange-600 shadow-orange-200",
} as const;

/** The small numbered circle preceding each dashboard card's title — mint by default, peach for the centerpiece card. */
export function CardBadge({ n, variant = "mint" }: { n: number; variant?: keyof typeof VARIANT_STYLE }) {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow-sm ${VARIANT_STYLE[variant]}`}
    >
      {n}
    </span>
  );
}
