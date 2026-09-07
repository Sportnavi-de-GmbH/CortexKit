"use client";

import { useCallback, useEffect, useState } from "react";

export type NavioTheme = "light" | "dark";

const STORAGE_KEY = "navio-theme";

/**
 * Widget theme, per the design spec §8: seeded from `prefers-color-scheme`,
 * persisted in localStorage. Dark mode is applied by putting `.theme-dark` on
 * the widget root (see NavioWidget), which swaps the CSS tokens tonally.
 */
export function useNavioTheme(): { theme: NavioTheme; toggle: () => void } {
  const [theme, setTheme] = useState<NavioTheme>("light");

  useEffect(() => {
    let initial: NavioTheme = "light";
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as NavioTheme | null;
      if (stored === "light" || stored === "dark") initial = stored;
      else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) initial = "dark";
    } catch {
      /* storage/matchMedia unavailable — stay light */
    }
    setTheme(initial);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: NavioTheme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
