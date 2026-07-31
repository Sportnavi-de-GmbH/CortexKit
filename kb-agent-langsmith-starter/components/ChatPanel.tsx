"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Brain, ChevronRight, MessageSquare, Paperclip, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { EveMessageData, EveMessagePart, UseEveAgentHelpers } from "eve/react";

type Agent = UseEveAgentHelpers<EveMessageData>;

// NOTE (starter): unlike example/knowledge-base-agent, this panel has NO
// feedback bar — user-feedback capture posts to LangSmith and belongs to the
// integration you build by following the guide, not to the clean testbed.

// Real questions the knowledge base answers — a starting point that exercises
// the prompt, not filler. Update these when the KB's scope changes.
const SUGGESTIONS = [
  "Wie kündige ich meine Mitgliedschaft?",
  "Wie funktioniert die Pause?",
  "Was ist Firmenfitness?",
];

export function ChatPanel({ agent }: { agent: Agent }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    setDraft("");
    void agent.send({ message: trimmed });
    inputRef.current?.focus();
  }

  // Grow the composer with its content instead of scrolling inside one row.
  // Writes only — no layout read during render.
  function autoGrow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <MessageList agent={agent} onPick={send} />

      <div className="px-6 pb-7 pt-2 sm:px-10">
        {/* Border lives in a class, not `style` — an inline border would beat the
            focus-within variant and the composer would never show focus. */}
        <div
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-(--border) px-4 py-2.5 shadow-[0_4px_16px_-6px_rgba(28,25,23,0.10)] transition-[border-color,box-shadow] focus-within:border-(--accent) focus-within:shadow-[0_6px_20px_-6px_rgba(149,193,30,0.28)]"
          style={{ background: "var(--bg-panel)" }}
        >
          <label htmlFor="kb-composer" className="sr-only">
            Ask a knowledge base question
          </label>
          {/* The textarea carries no focus ring of its own — the wrapper above
              shows focus via :focus-within for the whole compound control, and
              two nested rings read as a rendering bug. Suppressed in
              globals.css via #kb-composer, not a utility class. */}
          <textarea
            id="kb-composer"
            ref={(el) => {
              inputRef.current = el;
              autoGrow(el);
            }}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              autoGrow(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
            placeholder="Ask a knowledge base question…"
            rows={1}
            autoComplete="off"
            className="max-h-50 flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed placeholder:text-stone-400"
            style={{ color: "var(--text)" }}
          />
          {isBusy ? (
            <button
              type="button"
              onClick={() => agent.stop()}
              className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-rose-50"
              style={{ color: "var(--red)" }}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send(draft)}
              disabled={!draft.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-[0_8px_24px_-8px_rgba(149,193,30,0.5)] transition-[opacity,background-color] hover:bg-(--accent-hover) disabled:opacity-40 disabled:shadow-none"
              style={{ background: "var(--accent)", color: "#fff" }}
              aria-label="Send message"
            >
              <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-3xl px-1 text-[11px] text-stone-400">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}

function MessageList({ agent, onPick }: { agent: Agent; onPick: (text: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [agent.data.messages]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-10 sm:px-10">
      {agent.data.messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-(--accent-dim) text-(--accent)">
            <MessageSquare size={18} aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="font-headline text-[15px] font-semibold text-stone-800 text-balance">
              Ask something the knowledge base covers
            </h1>
            <p className="text-[12.5px] text-stone-400 text-pretty">
              Answers come only from the system prompt — no search, no retrieval.
            </p>
          </div>
          <div className="flex max-w-lg flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onPick(s)}
                className="rounded-full border border-stone-200 bg-white px-3.5 py-2 text-[12px] text-stone-600 shadow-xs transition-[color,border-color,background-color] hover:border-(--accent) hover:bg-(--accent-dim) hover:text-(--accent)"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        {agent.data.messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        {agent.status === "error" && agent.error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] leading-relaxed text-rose-700 wrap-break-word"
          >
            {agent.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

const MESSAGE_STATUS_LABEL: Record<string, string> = {
  streaming: "Responding",
  submitted: "Working",
  pending: "Working",
};

function MessageRow({ message }: { message: EveMessageData["messages"][number] }) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="pr-1 text-[11px] font-medium text-stone-400">You</span>
        <div className="min-w-0 max-w-[80%] rounded-2xl rounded-tr-sm px-3.5 py-2.5 soft-shadow" style={{ background: "var(--user-bubble)" }}>
          <div className="flex flex-col gap-2 text-[14px] leading-relaxed wrap-break-word" style={{ color: "var(--user-bubble-fg)" }}>
            {message.parts.map((part, index) => (
              <PartView key={index} part={part} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const status = message.metadata?.status;
  const statusLabel = status && status !== "complete" ? (MESSAGE_STATUS_LABEL[status] ?? status) : null;

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white shadow-[0_8px_24px_-10px_rgba(149,193,30,0.6)]" style={{ background: "var(--accent)" }}>
        <Sparkles size={14} strokeWidth={2.25} aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className="font-headline text-[12.5px] font-semibold text-stone-700">KB Agent</span>
          {statusLabel && (
            <span
              aria-live="polite"
              className="inline-flex items-center gap-1.5 rounded-full bg-(--accent-dim) px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-(--accent)"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--accent)" aria-hidden="true" />
              {statusLabel}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3 wrap-break-word">
          {message.parts.map((part, index) => (
            <PartView key={index} part={part} />
          ))}
        </div>
      </div>
    </div>
  );
}

// This agent has no tools and no subagents, so there are no tool-call or
// approval parts to render — text, reasoning, and files are the whole surface.
function PartView({ part }: { part: EveMessagePart }) {
  switch (part.type) {
    case "text":
      return (
        <div className="text-[14px] leading-[1.7] text-stone-800">
          <Markdown text={part.text} />
          {part.state === "streaming" && <Cursor />}
        </div>
      );
    case "reasoning":
      return <ReasoningBlock text={part.text} streaming={part.state === "streaming"} />;
    case "file":
      return (
        <a
          href={part.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-(--accent) transition-colors hover:bg-stone-50"
        >
          <Paperclip size={12} />
          {part.filename ?? part.mediaType}
        </a>
      );
    default:
      return null;
  }
}

/** Renders agent replies as formatted rich text instead of raw markdown source. */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="mb-2.5 whitespace-pre-wrap last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-stone-900">{children}</strong>,
        em: ({ children }) => <em>{children}</em>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="font-medium text-(--accent) underline decoration-(--accent) underline-offset-2 hover:opacity-80">
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="mb-2.5 flex list-disc flex-col gap-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2.5 flex list-decimal flex-col gap-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed [&>p]:mb-0">{children}</li>,
        h1: ({ children }) => <h4 className="mb-1.5 mt-3 font-headline text-[15px] font-semibold text-stone-900 first:mt-0">{children}</h4>,
        h2: ({ children }) => <h4 className="mb-1.5 mt-3 font-headline text-[15px] font-semibold text-stone-900 first:mt-0">{children}</h4>,
        h3: ({ children }) => <h4 className="mb-1.5 mt-3 font-headline text-[14px] font-semibold text-stone-900 first:mt-0">{children}</h4>,
        h4: ({ children }) => <h4 className="mb-1.5 mt-3 font-headline text-[14px] font-semibold text-stone-900 first:mt-0">{children}</h4>,
        code: ({ children, className }) =>
          className ? (
            <code className="mono block overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12px] leading-relaxed text-stone-700">
              {children}
            </code>
          ) : (
            <code className="mono rounded bg-stone-100 px-1.5 py-0.5 text-[12px] text-stone-700">{children}</code>
          ),
        pre: ({ children }) => <pre className="mb-2.5 last:mb-0">{children}</pre>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2.5 border-l-2 border-(--accent) pl-3 text-stone-600 last:mb-0">{children}</blockquote>
        ),
        hr: () => <hr className="my-3 border-stone-100" />,
        table: ({ children }) => (
          <div className="mb-2.5 overflow-x-auto last:mb-0">
            <table className="w-full border-collapse text-[13px]">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-stone-200 px-2.5 py-1.5 text-left font-semibold text-stone-700">{children}</th>
        ),
        td: ({ children }) => <td className="border-b border-stone-100 px-2.5 py-1.5 align-top">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function Cursor() {
  return (
    <span
      className="animate-pulse"
      style={{ display: "inline-block", width: 6, height: 12, background: "var(--accent)", marginLeft: 2, verticalAlign: "text-bottom" }}
    />
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-1.5 rounded-md text-[11px] font-medium text-stone-400 transition-colors hover:text-stone-600"
      >
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
          aria-hidden="true"
        >
          <ChevronRight size={12} />
        </span>
        <Brain size={12} aria-hidden="true" />
        Reasoning
        {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--accent)" aria-hidden="true" />}
      </button>
      {open && (
        <p
          id={panelId}
          className="mt-2 whitespace-pre-wrap rounded-xl border border-stone-100 bg-stone-50 p-3.5 text-[12.5px] leading-relaxed text-stone-600 wrap-break-word"
        >
          {text}
        </p>
      )}
    </div>
  );
}
