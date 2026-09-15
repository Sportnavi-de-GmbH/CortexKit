"use client";

// Header controls that depend on the current route: the section link (active
// state) and the sign-out button (hidden on the login page, where it is noise).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { ICON_BTN } from "./ui";

export function HeaderNav() {
  const pathname = usePathname();
  const onLogin = pathname === "/monitoring/login";
  const overviewActive = pathname === "/monitoring";
  return (
    <>
      {!onLogin && (
        <nav aria-label="Sections" className="hidden items-center gap-1 sm:flex">
          <Link
            href="/monitoring"
            aria-current={overviewActive ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 font-display text-sm font-medium transition-colors ${
              overviewActive ? "bg-(--surface-muted) text-(--fg)" : "text-(--fg-muted) hover:bg-(--surface-muted) hover:text-(--fg)"
            }`}
          >
            Overview
          </Link>
        </nav>
      )}
      {!onLogin && (
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => {
            void fetch("/api/monitoring/auth", { method: "DELETE" }).finally(() => window.location.assign("/monitoring/login"));
          }}
          className={ICON_BTN}
        >
          <LogOut className="h-4 w-4" />
        </button>
      )}
    </>
  );
}
