"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, BellOff, Search, Settings } from "lucide-react";
import { Tooltip } from "../Tooltip";

export function DashboardHeader({
  title,
  modelId,
  isConnected,
  isLive,
  query,
  onQueryChange,
  onOpenSettings,
}: {
  title: string;
  modelId?: string;
  isConnected: boolean;
  isLive: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onOpenSettings: () => void;
}) {
  const [notifOpen, setNotifOpen] = useState(false);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-stone-200 bg-white px-6">
      <div className="flex items-center gap-3">
        <h1 className="font-headline text-[15px] font-semibold tracking-tight text-stone-900">{title}</h1>
        {modelId && (
          <span className="mono rounded-full bg-teal-50 px-2.5 py-0.5 text-[11px] font-medium text-teal-700">{modelId}</span>
        )}
        <span className="flex items-center gap-1.5 rounded-full bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-500">
          <span className="relative flex h-2 w-2">
            {isLive && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${isConnected ? "bg-teal-500" : "bg-stone-300"}`} />
          </span>
          {isConnected ? "Live" : "Idle"}
        </span>
      </div>

      <div className="relative ml-auto hidden items-center gap-1 lg:flex">
        <Search size={15} className="pointer-events-none absolute left-3 text-stone-400" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter actions & partner activity…"
          className="w-64 rounded-lg border border-transparent bg-stone-50 py-1.5 pl-9 pr-3 text-xs text-stone-700 outline-none transition-all placeholder:text-stone-400 focus:border-teal-200 focus:bg-white focus:ring-2 focus:ring-teal-100"
        />
      </div>

      <div className="relative flex items-center gap-1.5 lg:ml-0 ml-auto">
        <div className="relative">
          <Tooltip label="Notifications" side="bottom" disabled={notifOpen}>
            <IconButton label="Notifications" onClick={() => setNotifOpen((v) => !v)} active={notifOpen}>
              <Bell size={17} strokeWidth={1.75} />
            </IconButton>
          </Tooltip>
          <AnimatePresence>
            {notifOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.12 }}
                className="absolute right-0 top-11 z-20 w-64 rounded-xl border border-stone-200 bg-white p-4 shadow-lg"
              >
                <div className="flex flex-col items-center gap-2 py-3 text-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-stone-50 text-stone-300">
                    <BellOff size={16} />
                  </span>
                  <p className="text-xs font-medium text-stone-500">No notifications yet</p>
                  <p className="text-[11px] text-stone-400">You&apos;ll see agent alerts here.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <Tooltip label="Agent settings" side="bottom">
          <IconButton label="Agent settings" onClick={onOpenSettings}>
            <Settings size={17} strokeWidth={1.75} />
          </IconButton>
        </Tooltip>

        <div className="mx-1 h-6 w-px bg-stone-200" />

        <div
          className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-900 text-xs font-semibold text-white ring-2 ring-white"
          title="Local dev session"
        >
          U
        </div>
      </div>
    </header>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.15 }}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        active ? "bg-teal-50 text-teal-600" : "text-stone-500 opacity-80 hover:bg-stone-50 hover:text-teal-600 hover:opacity-100"
      }`}
    >
      {children}
    </motion.button>
  );
}
