import Link from "next/link";
import { Activity } from "lucide-react";
import { LogoutButton } from "@/components/monitoring/LogoutButton";
import { ThemeToggle } from "@/components/monitoring/ThemeToggle";

export const metadata = { title: "Navio Monitoring" };

export default function MonitoringLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="monitoring-root" className="min-h-screen bg-(--bg) font-body text-(--fg)">
      <header className="sticky top-0 z-10 border-b border-(--border) bg-(--surface)">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/monitoring" className="flex items-center gap-2 font-display text-base font-semibold">
            <Activity className="h-5 w-5 text-(--brand-green)" /> Navio Monitoring
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
