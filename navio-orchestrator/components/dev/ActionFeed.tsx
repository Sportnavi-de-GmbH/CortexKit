"use client";

/**
 * ActionFeed — "what is Navio doing, right now", in plain language.
 *
 * One chronological card per step. A routing decision is the headline event,
 * because routing is the thing this whole system is for and the thing the
 * widget deliberately hides.
 */

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  HandHeart,
  MapPin,
  MessageSquare,
  Play,
  Send,
  Sparkles,
  User,
} from "lucide-react";
import type { CapabilityId, FeedRow, Kind } from "@/lib/dev-console/events";
import { CAPABILITIES } from "@/lib/dev-console/events";

const KIND_META: Record<
  Kind,
  { icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; color: string; bg: string }
> = {
  user: { icon: User, color: "text-stone-600", bg: "bg-stone-100" },
  thinking: { icon: Brain, color: "text-indigo-500", bg: "bg-indigo-50" },
  route: { icon: Sparkles, color: "text-[#6b8f10]", bg: "bg-[#f4f9e6]" },
  route_done: { icon: Bot, color: "text-cyan-600", bg: "bg-cyan-50" },
  reply: { icon: Send, color: "text-emerald-600", bg: "bg-emerald-50" },
  hitl: { icon: HandHeart, color: "text-[#ec6607]", bg: "bg-orange-50" },
  error: { icon: AlertTriangle, color: "text-rose-600", bg: "bg-rose-50" },
  session: { icon: Play, color: "text-stone-400", bg: "bg-stone-100" },
};

const CAP_ICON: Record<CapabilityId, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  faq: MessageSquare,
  find_partners: MapPin,
  request_human_contact: HandHeart,
  ask_question: Brain,
};

const STATUS_STYLE: Record<FeedRow["status"], string> = {
  running: "bg-[#f4f9e6] text-[#6b8f10]",
  done: "bg-emerald-50 text-emerald-600",
  error: "bg-rose-50 text-rose-600",
  waiting: "bg-orange-50 text-[#ec6607]",
};

const STATUS_LABEL: Record<FeedRow["status"], string> = {
  running: "working",
  done: "done",
  error: "failed",
  waiting: "waiting for visitor",
};

function secs(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ActionFeed({ rows, live }: { rows: FeedRow[]; live: boolean }) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-5 py-3.5">
        <h2 className="font-headline text-sm font-semibold text-stone-900">What Navio is doing</h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">
          {rows.length} steps
        </span>
        {live && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-[#6b8f10]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#95c11e] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#95c11e]" />
            </span>
            live
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {rows.length === 0 && (
          <p className="px-1 py-8 text-center text-sm text-stone-400">
            Send a message, or pick one of the example questions. Every decision Navio makes shows up here.
          </p>
        )}
        <AnimatePresence initial={false}>
          {rows.map((row) => (
            <FeedCard key={row.id} row={row} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function FeedCard({ row }: { row: FeedRow }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[row.kind];
  const Icon = row.capability ? CAP_ICON[row.capability] : meta.icon;
  const isRoute = row.kind === "route" || row.kind === "route_done";
  // A silent step over 25s is what kills a browser stream (CLAUDE.md §10.3).
  const slow = (row.durationMs ?? 0) > 25_000;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`rounded-xl border bg-white p-3.5 ${
        isRoute ? "border-[#95c11e]/35 shadow-[0_1px_0_rgba(149,193,30,.15)]" : "border-stone-200"
      } ${row.status === "error" ? "border-rose-200" : ""}`}
    >
      <div className="flex items-start gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.bg} ${meta.color}`}>
          <Icon size={16} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-headline text-[13px] font-semibold text-stone-900">{row.title}</h3>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[row.status]}`}>
              {STATUS_LABEL[row.status]}
            </span>
            {row.durationMs !== undefined && (
              <span className={`mono text-[10px] ${slow ? "font-bold text-[#ec6607]" : "text-stone-400"}`}>
                took {secs(row.durationMs)}
              </span>
            )}
            {row.at !== undefined && (
              <span className="mono ml-auto shrink-0 text-[10px] text-stone-300">+{secs(row.at)}</span>
            )}
          </div>

          <p className="mt-1 text-[12.5px] leading-relaxed text-stone-600 wrap-break-word">{row.description}</p>

          {row.capability && (
            <p className="mt-1.5 text-[11px] text-stone-400">{CAPABILITIES[row.capability].blurb}</p>
          )}

          <Detail row={row} open={open} onToggle={() => setOpen((v) => !v)} />
        </div>
      </div>
    </motion.article>
  );
}

/* ── technical detail ─────────────────────────────────────────────────────── */

type Tab = { id: string; label: string; value: unknown };

/**
 * The full, untruncated payload for a step: exactly what the model sent to the
 * tool, exactly what came back, and the raw eve stream event underneath both.
 *
 * Nothing here is abbreviated. The plain-language summary above the fold is for
 * reading; this is for debugging, and a debugger that hides bytes is useless —
 * the partner-agent bug earlier in this project was only findable by reading a
 * complete tool result.
 */
function Detail({
  row,
  open,
  onToggle,
}: {
  row: FeedRow;
  open: boolean;
  onToggle: () => void;
}) {
  const tabs: Tab[] = [];
  if (row.input !== undefined && row.input !== null) tabs.push({ id: "in", label: "Input", value: row.input });
  if (row.output !== undefined && row.output !== null) tabs.push({ id: "out", label: "Result", value: row.output });
  if (row.raw !== undefined && row.raw !== null) tabs.push({ id: "raw", label: "Raw event", value: row.raw });

  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  if (tabs.length === 0) return null;

  const current = tabs[Math.min(active, tabs.length - 1)];
  const text = render(current.value);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the text is on screen anyway */
    }
  }

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[11px] font-medium text-stone-400 transition-colors hover:text-stone-700"
        >
          <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "hide" : "show"} full detail
        </button>
        {row.toolName && (
          <span className="mono rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">{row.toolName}</span>
        )}
        {row.callId && (
          <span className="mono text-[10px] text-stone-300" title="eve call id — matches a call to its result">
            {row.callId.slice(0, 12)}…
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2 flex items-center gap-1 border-b border-stone-200 pb-1.5">
              {tabs.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActive(i)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    i === Math.min(active, tabs.length - 1)
                      ? "bg-stone-900 text-white"
                      : "text-stone-500 hover:bg-stone-100"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              <button
                type="button"
                onClick={copy}
                className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2} />}
                {copied ? "copied" : "copy"}
              </button>
              <span className="mono text-[10px] text-stone-300">{text.length} chars</span>
            </div>
            <pre className="mono max-h-96 overflow-auto rounded-b-lg bg-stone-50 p-2.5 text-[10.5px] leading-relaxed whitespace-pre-wrap wrap-break-word text-stone-700">
              {text}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Full fidelity — never truncate here. Strings stay strings so German prose
 *  stays readable instead of becoming an escaped JSON blob. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
