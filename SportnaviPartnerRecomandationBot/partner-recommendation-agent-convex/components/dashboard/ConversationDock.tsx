"use client";

/**
 * The conversation surface — a floating command bar at the bottom of the
 * single-page console. Collapsed it is just the bar; expanding reveals the
 * transcript in a panel directly above it.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronUp, MessageSquare, Square } from "lucide-react";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import { MessageList } from "../ChatPanel";
import { cumulativeUsage } from "../SessionBar";

type Agent = UseEveAgentHelpers<EveMessageData>;

const PANEL_HEIGHT = 440;

function fmtCount(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

export function ConversationDock({ agent }: { agent: Agent }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const usage = cumulativeUsage(agent.events);
  const messageCount = agent.data.messages.length;

  function submit() {
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    setExpanded(true);
    void agent.send({ message: text });
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-6 pb-6">
      <div className="pointer-events-auto w-full max-w-2xl">
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: PANEL_HEIGHT, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="mb-2 flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl"
            >
              <MessageList agent={agent} className="px-6 py-5" />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="rounded-2xl border border-stone-200 bg-white shadow-xl">
          <div className="flex items-center gap-3 rounded-t-2xl border-b border-stone-100 bg-stone-50/80 px-4 py-2 text-[11px] text-stone-400">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-stone-500 transition-colors hover:text-teal-700"
            >
              <MessageSquare size={12} />
              Conversation
              <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.15 }}>
                <ChevronUp size={12} />
              </motion.span>
            </button>
            {messageCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-500 transition-colors hover:bg-teal-50 hover:text-teal-700"
              >
                {messageCount} {messageCount === 1 ? "message" : "messages"}
              </button>
            )}
            {usage.inputTokens > 0 && (
              <span className="mono flex items-center gap-2" title="Cumulative tokens in / out">
                <span className="flex items-center gap-0.5">
                  <ArrowUp size={10} />
                  {fmtCount(usage.inputTokens)}
                </span>
                <span className="flex items-center gap-0.5">
                  <ArrowDown size={10} />
                  {fmtCount(usage.outputTokens)}
                </span>
                <span className="text-stone-300">tokens</span>
              </span>
            )}
            <div className="ml-auto flex items-center gap-3">
              {isBusy && (
                <button type="button" onClick={() => agent.stop()} className="flex items-center gap-1 font-medium text-rose-500 hover:text-rose-600">
                  <Square size={10} fill="currentColor" />
                  Stop
                </button>
              )}
              <button type="button" onClick={() => agent.reset()} className="font-medium text-stone-400 hover:text-stone-600">
                New session
              </button>
            </div>
          </div>

          <div className="flex items-end gap-2 px-4 py-2.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Message the agent…"
              rows={1}
              disabled={isBusy}
              className="flex-1 resize-none bg-transparent py-1.5 text-sm text-stone-800 outline-none placeholder:text-stone-400"
            />
            <motion.button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || isBusy}
              whileHover={{ scale: draft.trim() && !isBusy ? 1.06 : 1 }}
              whileTap={{ scale: draft.trim() && !isBusy ? 0.94 : 1 }}
              transition={{ duration: 0.12 }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-white shadow-lg shadow-teal-200 transition-opacity disabled:opacity-30 disabled:shadow-none"
              aria-label="Send"
            >
              <ArrowUp size={16} strokeWidth={2.25} />
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}
