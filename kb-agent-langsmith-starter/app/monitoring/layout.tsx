import Link from "next/link";
import "./monitoring.css";
import { BrandLogo } from "@/components/monitoring/BrandLogo";
import { HeaderNav } from "@/components/monitoring/HeaderNav";
import { ThemeToggle } from "@/components/monitoring/ThemeToggle";

export const metadata = { title: "Navio Monitoring · Sportnavi" };

// One header lockup on every screen (design guideline §6.1): the Sportnavi
// logo, a hairline divider, the product name. Controls on the right are
// circular ghost buttons with a 44 px hit area.
export default function MonitoringLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="monitoring-root" className="min-h-screen bg-(--bg) font-body text-[14px] leading-normal text-(--fg)">
      <header className="sticky top-0 z-20 border-b border-(--border) bg-(--surface)/90 backdrop-blur supports-[backdrop-filter]:bg-(--surface)/80">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/monitoring" className="flex min-w-0 items-center gap-3 rounded-lg" aria-label="Navio Monitoring — overview">
            <BrandLogo height={26} />
            <span className="h-6 w-px bg-(--border-strong)" aria-hidden />
            <span className="flex min-w-0 flex-col leading-none">
              <span className="truncate font-display text-[15px] font-semibold text-(--fg)">
                <span className="sm:hidden">Monitoring</span>
                <span className="hidden sm:inline">Navio Monitoring</span>
              </span>
              <span className="mt-0.5 hidden text-[11px] text-(--fg-subtle) sm:block">Agent traces · FAQ &amp; Partner</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <HeaderNav />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-center text-[11px] text-(--fg-subtle) sm:px-6">
        Sportnavi · Navio agent monitoring · internal
      </footer>
    </div>
  );
}
