"use client";

// Light/dark for the dashboard. Same `.theme-dark` class + tokens the widget
// uses (app/globals.css), toggled on the dashboard root and remembered per browser.
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { ICON_BTN } from "./ui";

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
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      aria-pressed={dark}
      className={ICON_BTN}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
