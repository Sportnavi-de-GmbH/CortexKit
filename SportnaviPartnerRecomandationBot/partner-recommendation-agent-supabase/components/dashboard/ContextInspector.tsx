"use client";

/**
 * Card 3 — Active Context Window Inspector. Every number here is real: the
 * token counter is the provider-measured size (falling back to a chars÷4
 * estimate before the first model call), and each accordion's count is the
 * same estimate the rest of the app already uses.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Copy } from "lucide-react";
import type { EveMessageData, EveMessagePart, UseEveAgentHelpers } from "eve/react";
import { currentContextTokens, estimateTokens, formatTokens, type AgentInfoLike } from "@/lib/dev-console/observability";
import { CardBadge } from "./CardBadge";

type Agent = UseEveAgentHelpers<EveMessageData>;
type Message = EveMessageData["messages"][number];

export function ContextInspector({
  agent,
  info,
}: {
  agent: Agent;
  info: AgentInfoLike | null;
}) {
  const measured = currentContextTokens(agent.events);
  const systemMd = info?.instructions?.static?.markdown ?? "";
  const tools = info?.tools?.available ?? [];
  const maxTokens = info?.agent?.model?.contextWindowTokens;

  const systemTokens = estimateTokens(systemMd);
  const toolTokens = tools.reduce((sum, t) => sum + estimateTokens(`${t.name} ${t.description ?? ""}`), 0);
  const conversationTokens = agent.data.messages.reduce((sum, m) => sum + messageTokens(m), 0);
  const totalEstimated = systemTokens + toolTokens + conversationTokens;

  const used = Math.max(measured, totalEstimated);
  const percent = maxTokens ? Math.min(100, (used / maxTokens) * 100) : 0;

  const hiddenOverhead = measured > totalEstimated ? measured - totalEstimated : 0;

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-stone-200 bg-white shadow-sm">
      <header className="border-b border-stone-100 bg-linear-to-b from-orange-50/60 to-transparent px-5 py-4">
        <div className="flex items-center gap-2">
          <CardBadge n={3} variant="peach" />
          <h2 className="font-headline text-sm font-semibold text-orange-700">Active Context Window Inspector</h2>
        </div>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="mono text-xl font-semibold tracking-tight text-stone-900">
            {formatTokens(used)} <span className="text-sm font-normal text-stone-400">/ {maxTokens ? formatTokens(maxTokens) : "—"} tokens</span>
          </span>
          <span className="mono rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-600">{percent.toFixed(1)}%</span>
        </div>
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
          <motion.div
            className="h-full rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.4)]"
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(1.5, percent)}%` }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <Accordion title="System Prompt" tokens={systemTokens} copyText={systemMd} defaultOpen={false}>
          {systemMd ? (
            <CodeBlock text={systemMd} />
          ) : (
            <p className="text-xs text-stone-400">Not loaded (agent info unavailable).</p>
          )}
        </Accordion>

        <Accordion title="Active Tool Memory / Schemas" tokens={toolTokens} copyText={tools.map((t) => t.name).join(", ")} defaultOpen={false}>
          {tools.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {tools.map((t) => (
                <div key={t.name} className="rounded-lg border border-stone-100 bg-stone-50 px-2.5 py-1.5">
                  <div className="mono text-[12px] font-medium text-orange-700">{t.name}</div>
                  {t.description && <div className="mt-0.5 text-[11px] leading-relaxed text-stone-500">{t.description}</div>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-stone-400">No tools loaded.</p>
          )}
        </Accordion>

        <Accordion
          title="Conversation History (Sliding Window)"
          tokens={conversationTokens}
          subtitle={`${agent.data.messages.length} messages`}
          defaultOpen={false}
        >
          {agent.data.messages.length > 0 ? (
            <div className="flex flex-col gap-2">
              {agent.data.messages.map((m) => {
                const text = fullText(m);
                const toolCalls = toolCallNames(m);
                if (!text && toolCalls.length === 0) return null;
                return (
                  <div key={m.id} className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-stone-600">
                    <span className="mono font-semibold text-stone-800">{m.role}: </span>
                    {toolCalls.length > 0 && (
                      <span className="mono text-teal-700">
                        {toolCalls.map((name) => `🔧 ${name}`).join("  ")}
                        {text ? " — " : ""}
                      </span>
                    )}
                    {text}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-stone-400">No messages yet.</p>
          )}
        </Accordion>

        {hiddenOverhead > 0 && (
          <div className="-mx-1 flex items-center gap-2 px-1 py-2.5">
            <span className="pl-6 text-[13px] font-medium text-stone-500">Framework overhead (hidden context)</span>
            <span
              className="mono ml-auto text-[11px] text-stone-400"
              title="Provider-measured prompt minus the visible sections: eve's scaffolding, dynamic instruction wrappers, and provider-side tool schema formatting."
            >
              {formatTokens(hiddenOverhead)} tokens
            </span>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-orange-100 bg-orange-50/60 px-5 py-3">
        <span className="text-xs font-medium text-orange-700">
          {measured > 0 ? "Total Context (provider-measured)" : "Total Estimated Tokens"}
        </span>
        <span className="mono text-xs font-semibold text-orange-700">{formatTokens(used)} tokens</span>
      </footer>
    </section>
  );
}

function messageTokens(message: Message): number {
  return message.parts.reduce((sum, p: EveMessagePart) => (p.type === "text" || p.type === "reasoning" ? sum + estimateTokens(p.text) : sum), 0);
}

function fullText(message: Message): string {
  return message.parts
    .map((p: EveMessagePart) => (p.type === "text" || p.type === "reasoning" ? p.text : ""))
    .join(" ")
    .trim();
}

function toolCallNames(message: Message): string[] {
  return message.parts
    .filter((p: EveMessagePart) => p.type === "dynamic-tool")
    .map((p) => ("toolName" in p ? p.toolName.replace(/^eve:subagent:/, "") : "tool"));
}

function Accordion({
  title,
  subtitle,
  tokens,
  copyText,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  tokens: number;
  copyText?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const userToggled = useRef(false);
  useEffect(() => {
    if (!userToggled.current) setOpen(defaultOpen);
  }, [defaultOpen]);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    if (!copyText) return;
    void navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="-mx-1 rounded-lg border-b border-stone-100 px-1 py-2.5 transition-colors last:border-b-0 hover:bg-stone-50">
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          onClick={() => {
            userToggled.current = true;
            setOpen((v) => !v);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: 0.15 }} className="text-stone-400">
            <ChevronDown size={14} />
          </motion.span>
          <span className="text-[13px] font-medium text-stone-800">{title}</span>
          <span className="mono ml-auto text-[11px] text-stone-400">
            {subtitle ? `${subtitle} · ` : ""}
            {formatTokens(tokens)} tokens
          </span>
        </button>
        {copyText && (
          <button
            type="button"
            onClick={copy}
            title="Copy"
            className={`shrink-0 rounded-md p-1 transition-colors ${copied ? "text-emerald-600" : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"}`}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="pl-6 pt-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-[11.5px] leading-relaxed text-stone-700">
      {text}
    </pre>
  );
}
