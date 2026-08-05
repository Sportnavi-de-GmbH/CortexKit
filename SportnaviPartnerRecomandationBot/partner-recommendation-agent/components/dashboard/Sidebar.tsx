"use client";

import { motion } from "framer-motion";
import { Activity, Settings, Sparkles } from "lucide-react";
import { Tooltip } from "../Tooltip";

export function Sidebar({ onOpenActivity, onOpenSettings }: { onOpenActivity: () => void; onOpenSettings: () => void }) {
  return (
    <aside className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-stone-200 bg-white py-4">
      <Tooltip label="Partner Agent Console" side="right">
        <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 text-white shadow-sm shadow-teal-200">
          <Sparkles size={17} strokeWidth={2.25} />
        </div>
      </Tooltip>

      <NavIcon icon={Activity} label="Full activity log" onClick={onOpenActivity} />

      <div className="mt-auto">
        <NavIcon icon={Settings} label="Agent settings & info" onClick={onOpenSettings} />
      </div>
    </aside>
  );
}

function NavIcon({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} side="right">
      <motion.button
        type="button"
        onClick={onClick}
        aria-label={label}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.96 }}
        transition={{ duration: 0.15 }}
        className="flex h-10 w-10 items-center justify-center rounded-xl text-stone-400 transition-colors hover:bg-stone-100 hover:text-teal-600"
      >
        <Icon size={18} strokeWidth={2} />
      </motion.button>
    </Tooltip>
  );
}
