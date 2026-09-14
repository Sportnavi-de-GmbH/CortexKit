"use client";

// Light/dark for the dashboard. Same `.theme-dark` class + tokens the widget
// uses (app/globals.css), toggled on the dashboard root and remembered per browser.
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "navio-monitoring-theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "dark") setDark(true);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    document.getElementById("monitoring-root")?.classList.toggle("theme-dark", dark);
    try {
      localStorage.setItem(KEY, dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);
  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      aria-label="Toggle theme"
      className="flex h-9 w-9 items-center justify-center rounded-full border border-(--border) text-(--fg-muted) hover:bg-(--surface-muted)"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
