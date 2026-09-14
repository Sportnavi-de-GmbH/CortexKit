"use client";

import { LogOut } from "lucide-react";

export function LogoutButton() {
  return (
    <button
      type="button"
      aria-label="Sign out"
      onClick={() => {
        void fetch("/api/monitoring/auth", { method: "DELETE" }).finally(() => window.location.assign("/monitoring/login"));
      }}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-(--border) text-(--fg-muted) hover:bg-(--surface-muted)"
    >
      <LogOut className="h-4 w-4" />
    </button>
  );
}
