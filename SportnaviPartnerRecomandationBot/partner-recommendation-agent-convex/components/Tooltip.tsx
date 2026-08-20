"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/** A small delayed hover tooltip for icon-only controls across the console. */
export function Tooltip({
  label,
  side = "right",
  disabled = false,
  children,
}: {
  label: string;
  side?: "right" | "bottom";
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const show = visible && !disabled;

  const positionClass =
    side === "right"
      ? "left-full top-1/2 ml-2 -translate-y-1/2"
      : "left-1/2 top-full mt-2 -translate-x-1/2";

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, scale: 0.96, y: side === "bottom" ? -2 : 0, x: side === "right" ? -2 : 0 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.12 }}
            className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-lg bg-stone-900 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg ${positionClass}`}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
