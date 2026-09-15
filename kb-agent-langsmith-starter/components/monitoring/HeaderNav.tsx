"use client";

// Header controls that depend on the current route: the section links (active
// state) and the sign-out button (hidden on the login page, where it is noise).
// The Alerts link carries a red dot while any rule is breached.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { ICON_BTN } from "./ui";

export function HeaderNav() {
  const pathname = usePathname();
  const onLogin = pathname === "/monitoring/login";
  const overviewActive = pathname === "/monitoring";
  const alertsActive = pathname.startsWith("/monitoring/alerts");
  const [breached, setBreached] = useState(0);

  useEffect(() => {
    if (onLogin) return;
    let live = true;
    function refresh() {
      fetch("/api/monitoring/alerts/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { count?: number } | null) => {
          if (live && b && typeof b.count === "number") setBreached(b.count);
        })
        .catch(() => {
          /* the dot is a nicety; a failed status call must not break the header */
        });
    }
    refresh();
    // Delete flows dispatch this after router.refresh() so a removed alert
    // clears the dot without waiting for the next navigation.
    window.addEventListener("navio:refresh", refresh);
    return () => {
      live = false;
      window.removeEventListener("navio:refresh", refresh);
    };
  }, [onLogin, pathname]);

  const linkCls = (active: boolean) =>
    `inline-flex items-center rounded-full px-3 py-1.5 font-display text-sm font-medium transition-colors ${
      active ? "bg-(--surface-muted) text-(--fg)" : "text-(--fg-muted) hover:bg-(--surface-muted) hover:text-(--fg)"
    }`;

  return (
    <>
      {!onLogin && (
        <nav aria-label="Sections" className="hidden items-center gap-1 sm:flex">
          <Link href="/monitoring" aria-current={overviewActive ? "page" : undefined} className={linkCls(overviewActive)}>
            Overview
          </Link>
          <Link href="/monitoring/alerts" aria-current={alertsActive ? "page" : undefined} className={linkCls(alertsActive)}>
            Alerts
            {breached > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-(--red)" aria-label="Regeln verletzt" />}
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
