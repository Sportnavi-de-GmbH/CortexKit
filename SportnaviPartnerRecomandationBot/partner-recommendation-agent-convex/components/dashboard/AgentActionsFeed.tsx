"use client";

/**
 * Card 1 — Real-Time Agent Actions. The live event stream (reasoning, tool
 * calls, subagent hops, responses, errors) as a single chronological feed.
 */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Brain,
  ChevronDown,
  GitBranch,
  Radio,
  Send,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import { eventTimestamp } from "@/lib/dev-console/events";
import { JsonView } from "../JsonView";
import { CardBadge } from "./CardBadge";

type Agent = UseEveAgentHelpers<EveMessageData>;
type Kind = "thinking" | "tool_call" | "tool_result" | "subagent" | "response" | "auth" | "hitl" | "error" | "compaction";
type Status = "done" | "running" | "error";

interface FeedRow {
  id: string;
  time?: string;
  kind: Kind;
  title: string;
  description: string;
  status: Status;
  detail?: unknown;
}

const KIND_META: Record<Kind, { icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; color: string; bg: string }> = {
  thinking: { icon: Brain, color: "text-indigo-500", bg: "bg-indigo-50" },
  tool_call: { icon: Terminal, color: "text-blue-600", bg: "bg-blue-50" },
  tool_result: { icon: Server, color: "text-cyan-600", bg: "bg-cyan-50" },
  subagent: { icon: GitBranch, color: "text-amber-600", bg: "bg-amber-50" },
  response: { icon: Send, color: "text-emerald-600", bg: "bg-emerald-50" },
  auth: { icon: ShieldCheck, color: "text-amber-600", bg: "bg-amber-50" },
  hitl: { icon: AlertCircle, color: "text-amber-600", bg: "bg-amber-50" },
  error: { icon: AlertTriangle, color: "text-rose-600", bg: "bg-rose-50" },
  compaction: { icon: Archive, color: "text-stone-500", bg: "bg-stone-100" },
};

const STATUS_STYLE: Record<Status, string> = {
  done: "bg-emerald-50 text-emerald-600",
  running: "bg-teal-50 text-teal-600",
  error: "bg-rose-50 text-rose-600",
};

function buildFeed(agent: Agent): FeedRow[] {
  const rows: FeedRow[] = [];

  for (const event of agent.events) {
    const time = eventTimestamp(event);
    switch (event.type) {
      case "reasoning.completed":
        rows.push({ id: `${event.type}-${time}`, time, kind: "thinking", title: "Thinking", description: truncate(event.data.reasoning), status: "done" });
        break;
      case "actions.requested":
        for (const action of event.data.actions) {
          const name = action.kind === "tool-call" ? action.toolName : action.kind === "subagent-call" ? action.subagentName : "action";
          if (action.kind === "subagent-call") {
            rows.push({
              id: `subagent-${action.callId}`,
              time,
              kind: "subagent",
              title: `Delegating to ${name}`,
              description: "Routing to a specialised subagent",
              status: "running",
              detail: "input" in action ? action.input : undefined,
            });
          } else {
            rows.push({
              id: `tool-${action.callId}`,
              time,
              kind: "tool_call",
              title: `Tool Call: ${name}`,
              description: "Calling a tool",
              status: "running",
              detail: "input" in action ? action.input : undefined,
            });
          }
        }
        break;
      case "action.result": {
        const r = event.data.result;
        const failed = event.data.status !== "completed";
        if (r.kind === "subagent-result") {
          rows.push({
            id: `subagent-result-${r.callId}`,
            time,
            kind: "subagent",
            title: `${r.subagentName} done`,
            description: failed ? (event.data.error?.message ?? "failed") : "Subagent returned a result",
            status: failed ? "error" : "done",
            detail: r.output,
          });
        } else {
          rows.push({
            id: `tool-result-${r.callId}`,
            time,
            kind: "tool_result",
            title: "Tool Result",
            description: failed ? (event.data.error?.message ?? "failed") : "Found a result",
            status: failed ? "error" : "done",
            detail: r.output,
          });
        }
        break;
      }
      case "message.completed":
        rows.push({
          id: `response-${time}`,
          time,
          kind: "response",
          title: "Response Sent",
          description: "Successfully delivered to user",
          status: "done",
        });
        break;
      case "authorization.required":
        rows.push({ id: `auth-req-${time}`, time, kind: "auth", title: "Authorization needed", description: event.data.description, status: "running" });
        break;
      case "authorization.completed":
        rows.push({
          id: `auth-done-${time}`,
          time,
          kind: "auth",
          title: `${event.data.name} authorization`,
          description: event.data.outcome,
          status: event.data.outcome === "authorized" ? "done" : "error",
        });
        break;
      case "input.requested":
        rows.push({
          id: `hitl-${time}`,
          time,
          kind: "hitl",
          title: "Needs your input",
          description: event.data.requests.map((r) => r.prompt).join(" • "),
          status: "running",
        });
        break;
      case "compaction.requested":
        rows.push({ id: `compaction-${time}`, time, kind: "compaction", title: "Compacting history", description: "Trimming the transcript to fit", status: "running" });
        break;
      case "compaction.completed":
        rows.push({ id: `compaction-done-${time}`, time, kind: "compaction", title: "Compaction checkpoint", description: "History compacted", status: "done" });
        break;
      case "step.failed":
      case "turn.failed":
      case "session.failed":
        rows.push({ id: `error-${event.type}-${time}`, time, kind: "error", title: "Error", description: `${event.data.code}: ${event.data.message}`, status: "error" });
        break;
      default:
        break;
    }
  }

  return rows.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

function truncate(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function AgentActionsFeed({
  agent,
  query,
  onOpenActivity,
}: {
  agent: Agent;
  query: string;
  onOpenActivity: () => void;
}) {
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const feed = useMemo(() => buildFeed(agent), [agent]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return feed
      .filter((row) => !clearedAt || (row.time ?? "") > clearedAt)
      .filter((row) => !q || row.title.toLowerCase().includes(q) || row.description.toLowerCase().includes(q))
      .slice(-12)
      .reverse();
  }, [feed, clearedAt, query]);

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-stone-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <CardBadge n={1} />
            <h2 className="font-headline text-sm font-semibold text-stone-900">Real-Time Agent Actions</h2>
          </div>
          <p className="ml-7 flex items-center gap-1.5 text-xs text-stone-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-500" />
            </span>
            Live feed
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={onOpenActivity} className="text-xs font-medium text-teal-600 hover:text-teal-700">
            View all
          </button>
          <button
            type="button"
            onClick={() => setClearedAt(new Date().toISOString())}
            className="text-xs font-medium text-stone-400 hover:text-stone-600"
          >
            Clear
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-stone-50 text-stone-300">
              <Radio size={16} />
            </span>
            <p className="text-xs text-stone-400">Nothing yet — send a message to see the agent work.</p>
          </div>
        ) : (
          <ol className="relative">
            <div className="absolute bottom-2 left-3.25 top-2 w-px bg-stone-200" />
            <AnimatePresence initial={false}>
              {visible.map((row) => {
                const meta = KIND_META[row.kind];
                const Icon = meta.icon;
                const isOpen = toggled[row.id] ?? (row.status === "running" && row.detail !== undefined);
                return (
                  <motion.li
                    key={row.id}
                    layout
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="relative mb-4 flex gap-3 last:mb-0"
                  >
                    <span className={`relative z-10 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full ring-[3px] ring-white ${meta.bg} ${meta.color}`}>
                      <Icon size={13} strokeWidth={2.25} />
                    </span>
                    <div className="min-w-0 flex-1 rounded-lg px-1 py-0.5 transition-colors hover:bg-stone-50">
                      <div className="flex items-center gap-2">
                        <span className="mono text-[11px] text-stone-400">{formatFeedTime(row.time)}</span>
                        <span className="text-[13px] font-medium text-stone-800">{row.title}</span>
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-stone-500">{row.description}</p>
                      {row.detail !== undefined && (
                        <>
                          <button
                            type="button"
                            onClick={() => setToggled((prev) => ({ ...prev, [row.id]: !isOpen }))}
                            className="mt-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-teal-600"
                          >
                            <motion.span animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.15 }}>
                              <ChevronDown size={11} />
                            </motion.span>
                            JSON payload
                          </button>
                          <AnimatePresence>
                            {isOpen && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="overflow-hidden"
                              >
                                <div className="mono mt-1.5 rounded-lg border border-stone-100 bg-stone-50 p-2.5 text-[11px]">
                                  <JsonView value={row.detail} />
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </section>
  );
}

function formatFeedTime(time: string | undefined): string {
  if (!time) return "—";
  try {
    return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return time;
  }
}
