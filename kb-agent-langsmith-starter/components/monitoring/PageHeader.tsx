// Page title block: breadcrumb (optional) · h1 · one-line description · actions.
// One h1 per page (heading-hierarchy rule); the crumb is a <nav>.
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({
  crumbs,
  title,
  description,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-(--fg-subtle)">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden />}
                {c.href ? (
                  <Link href={c.href} className="rounded transition-colors hover:text-(--fg)">
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-(--fg-muted)">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.01em] text-(--fg) sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-(--fg-muted)">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
