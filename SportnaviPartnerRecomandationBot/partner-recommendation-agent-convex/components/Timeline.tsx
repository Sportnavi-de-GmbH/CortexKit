"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { HandleMessageStreamEvent } from "eve/client";
import { categoryColor, correlateToolCalls, eventCategory, eventSummary, eventTimestamp, formatClock } from "@/lib/dev-console/events";
import { JsonView } from "./JsonView";

const CATEGORIES = ["lifecycle", "message", "reasoning", "tool", "subagent", "hitl", "auth", "error"] as const;

export function Timeline({ events }: { events: readonly HandleMessageStreamEvent[] }) {
  const [tab, setTab] = useState<"events" | "tools">("events");
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set(CATEGORIES));
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (!activeCategories.has(eventCategory(event))) return false;
      if (!q) return true;
      return event.type.toLowerCase().includes(q) || eventSummary(event).toLowerCase().includes(q);
    });
  }, [events, activeCategories, query]);

  const toolCalls = useMemo(() => correlateToolCalls(events), [events]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-3 pt-2.5" style={{ borderColor: "var(--border)" }}>
        <TabButton active={tab === "events"} onClick={() => setTab("events")}>
          Timeline
        </TabButton>
        <TabButton active={tab === "tools"} onClick={() => setTab("tools")}>
          Tool calls {toolCalls.length > 0 && <span style={{ color: "var(--text-faint)" }}>({toolCalls.length})</span>}
        </TabButton>
      </div>

      {tab === "events" ? (
        <>
          <div className="flex flex-col gap-2.5 border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter events…"
                className="w-full rounded-lg border py-1.5 pl-8 pr-2.5 text-xs outline-none transition-colors focus:border-(--accent)"
                style={{ borderColor: "var(--border)", background: "var(--bg-panel-raised)", color: "var(--text)" }}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((category) => {
                const active = activeCategories.has(category);
                const color = categoryColor(category);
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() =>
                      setActiveCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(category)) next.delete(category);
                        else next.add(category);
                        return next;
                      })
                    }
                    className="rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors"
                    style={
                      active
                        ? { borderColor: color, color, background: `color-mix(in srgb, ${color} 10%, transparent)` }
                        : { borderColor: "var(--border)", color: "var(--text-faint)" }
                    }
                  >
                    {category}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-xs" style={{ color: "var(--text-faint)" }}>
                No events yet.
              </div>
            )}
            {filtered.map((event, index) => (
              <EventRow key={index} event={event} />
            ))}
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          {toolCalls.length === 0 && (
            <div className="px-3 py-8 text-center text-xs" style={{ color: "var(--text-faint)" }}>
              No tool calls yet.
            </div>
          )}
          {toolCalls.map((call) => (
            <ToolCallRow key={call.callId} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "transparent",
        color: active ? "var(--text)" : "var(--text-faint)",
      }}
    >
      {children}
    </button>
  );
}

function EventRow({ event }: { event: HandleMessageStreamEvent }) {
  const [open, setOpen] = useState(false);
  const category = eventCategory(event);
  const color = categoryColor(category);

  return (
    <div className="rounded-lg px-2.5 py-2 transition-colors hover:bg-(--bg-panel-raised)">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 text-left">
        <span className="mt-1 shrink-0 transition-transform" style={{ color: "var(--text-faint)", transform: open ? "rotate(90deg)" : undefined }}>
          <ChevronRight size={12} />
        </span>
        <span className="mono mt-0.5 shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>
          {formatClock(eventTimestamp(event))}
        </span>
        <span className="mt-1.5 shrink-0" style={{ width: 6, height: 6, borderRadius: 999, background: color }} />
        <span className="flex-1 text-xs">
          <span className="mono font-medium" style={{ color }}>
            {event.type}
          </span>
          <span className="ml-2" style={{ color: "var(--text-dim)" }}>
            {eventSummary(event)}
          </span>
        </span>
      </button>
      {open && (
        <div className="mono mt-2 rounded-lg pl-4 pr-2 py-2 text-xs" style={{ marginLeft: 26, background: "var(--bg-panel-raised)" }}>
          <JsonView value={event} />
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--yellow)",
  completed: "var(--accent)",
  failed: "var(--red)",
  rejected: "var(--red)",
};

function ToolCallRow({ call }: { call: ReturnType<typeof correlateToolCalls>[number] }) {
  const [open, setOpen] = useState(true);
  const color = STATUS_COLOR[call.status];

  return (
    <div className="mb-1.5 rounded-xl border p-3 last:mb-0" style={{ borderColor: "var(--border)", background: "var(--bg-panel)" }}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <span className="shrink-0 transition-transform" style={{ color: "var(--text-faint)", transform: open ? "rotate(90deg)" : undefined }}>
          <ChevronRight size={12} />
        </span>
        <span className="mono text-xs font-medium" style={{ color: "var(--accent)" }}>
          {call.name}
        </span>
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
        >
          {call.status}
        </span>
        <span className="mono ml-auto text-[10px]" style={{ color: "var(--text-faint)" }}>
          step {call.stepIndex}
        </span>
      </button>
      {open && (
        <div className="mono mt-2 pl-5 text-xs">
          {call.input !== undefined && (
            <div className="mb-1.5">
              <div className="mb-0.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                input
              </div>
              <JsonView value={call.input} />
            </div>
          )}
          {call.output !== undefined && (
            <div className="mb-1.5">
              <div className="mb-0.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                output
              </div>
              <JsonView value={call.output} />
            </div>
          )}
          {call.error && (
            <div style={{ color: "var(--red)" }}>
              {call.error.code}: {call.error.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
