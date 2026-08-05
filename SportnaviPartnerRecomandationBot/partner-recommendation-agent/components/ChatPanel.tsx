"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  GitBranch,
  MessageSquare,
  Paperclip,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { UseEveAgentHelpers } from "eve/react";
import type { EveMessageData, EveMessagePart } from "eve/react";
import { JsonView } from "./JsonView";

type Agent = UseEveAgentHelpers<EveMessageData>;

/** The scrollable message transcript — reused by the full ChatPanel and by the dashboard's ConversationDock. */
export function MessageList({ agent, className = "px-10 py-10" }: { agent: Agent; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [agent.data.messages]);

  return (
    <div ref={scrollRef} className={`flex-1 overflow-y-auto ${className}`}>
      {agent.data.messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-50 text-stone-300">
            <MessageSquare size={17} />
          </span>
          <p className="text-[13px] text-stone-400">Send a message to start a session.</p>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        {agent.data.messages.map((message) => (
          <MessageRow key={message.id} message={message} agent={agent} />
        ))}
        {agent.status === "error" && agent.error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] leading-relaxed text-rose-600">
            {agent.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({ agent }: { agent: Agent }) {
  const [draft, setDraft] = useState("");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  function submit() {
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    void agent.send({ message: text });
  }

  return (
    <div className="flex h-full flex-col">
      <MessageList agent={agent} />

      <div className="px-10 pb-8 pt-2">
        <div
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl px-4 py-2.5 shadow-lg transition-colors focus-within:border-(--accent)"
          style={{ background: "var(--bg-panel-raised)", border: "1px solid var(--border)" }}
        >
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
            className="flex-1 resize-none bg-transparent py-1.5 text-sm outline-none"
            style={{ color: "var(--text)" }}
          />
          {isBusy ? (
            <button
              type="button"
              onClick={() => agent.stop()}
              className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ color: "var(--red)" }}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-lg shadow-teal-200 transition-opacity disabled:opacity-30 disabled:shadow-none"
              style={{ background: "var(--accent)", color: "#fff" }}
              aria-label="Send"
            >
              <ArrowUp size={16} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const MESSAGE_STATUS_LABEL: Record<string, string> = {
  streaming: "Responding",
  submitted: "Working",
  pending: "Working",
};

function MessageRow({ message, agent }: { message: EveMessageData["messages"][number]; agent: Agent }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="pr-1 text-[11px] font-medium text-stone-400">You</span>
        <div className="max-w-[75%] rounded-2xl rounded-tr-md border border-teal-100 bg-teal-50/70 px-4 py-3">
          <div className="flex flex-col gap-2 text-[14px] leading-relaxed text-stone-800">
            {message.parts.map((part, index) => (
              <PartView key={index} part={part} agent={agent} />
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
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white shadow-sm shadow-teal-200">
        <Sparkles size={14} strokeWidth={2.25} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="font-headline text-[12.5px] font-semibold text-stone-700">Partner Agent</span>
          {statusLabel && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              {statusLabel}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-3">
          {message.parts.map((part, index) => (
            <PartView key={index} part={part} agent={agent} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PartView({ part, agent }: { part: EveMessagePart; agent: Agent }) {
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
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-teal-700 transition-colors hover:bg-stone-50"
        >
          <Paperclip size={12} />
          {part.filename ?? part.mediaType}
        </a>
      );
    case "step-start":
      return null;
    case "authorization":
      return <AuthorizationCard part={part} />;
    case "dynamic-tool":
      return <ToolCallCard part={part} agent={agent} />;
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
          <a href={href} target="_blank" rel="noreferrer" className="font-medium text-teal-700 underline decoration-teal-300 underline-offset-2 hover:text-teal-800">
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
          <blockquote className="mb-2.5 border-l-2 border-teal-200 pl-3 text-stone-600 last:mb-0">{children}</blockquote>
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
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium text-stone-400 transition-colors hover:text-stone-600"
      >
        <span className="inline-flex transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }}>
          <ChevronRight size={12} />
        </span>
        <Brain size={12} />
        Reasoning
        {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />}
      </button>
      {open && (
        <p className="mt-2 whitespace-pre-wrap rounded-xl border border-stone-100 bg-stone-50 p-3.5 text-[12.5px] leading-relaxed text-stone-600">
          {text}
        </p>
      )}
    </div>
  );
}

function AuthorizationCard({ part }: { part: Extract<EveMessagePart, { type: "authorization" }> }) {
  return (
    <div className="w-full rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs">
      <div className="flex items-center gap-2 font-semibold text-amber-700">
        <ShieldCheck size={14} />
        {part.displayName}
      </div>
      <p className="mt-1 leading-relaxed text-stone-500">{part.description}</p>
      {part.state === "required" ? (
        <div className="mt-2 flex items-center gap-3">
          {part.authorization?.userCode && (
            <code className="rounded-md border border-amber-200 bg-white px-2 py-1 font-semibold tracking-wider text-stone-700">
              {part.authorization.userCode}
            </code>
          )}
          {part.authorization?.url && (
            <a
              href={part.authorization.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-teal-700 hover:underline"
            >
              Sign in →
            </a>
          )}
        </div>
      ) : (
        <div className={`mt-1.5 font-semibold ${part.outcome === "authorized" ? "text-emerald-600" : "text-rose-600"}`}>
          {part.outcome}
        </div>
      )}
    </div>
  );
}

const TOOL_STATE_LABEL: Record<string, string> = {
  "input-streaming": "streaming input",
  "input-available": "running",
  "approval-requested": "needs approval",
  "approval-responded": "approved",
  "output-available": "done",
  "output-error": "failed",
  "output-denied": "denied",
};

const TOOL_STATE_STYLE: Record<string, string> = {
  "input-streaming": "bg-stone-100 text-stone-500",
  "input-available": "bg-amber-50 text-amber-600",
  "approval-requested": "bg-amber-50 text-amber-600",
  "approval-responded": "bg-stone-100 text-stone-500",
  "output-available": "bg-emerald-50 text-emerald-600",
  "output-error": "bg-rose-50 text-rose-600",
  "output-denied": "bg-rose-50 text-rose-600",
};

const TOOL_STATE_RUNNING = new Set(["input-streaming", "input-available", "approval-requested"]);

function ToolCallCard({ part, agent }: { part: Extract<EveMessagePart, { type: "dynamic-tool" }>; agent: Agent }) {
  const [open, setOpen] = useState(false);
  const kind = part.toolMetadata?.eve?.kind ?? "tool-call";
  const request = part.toolMetadata?.eve?.inputRequest;
  const isSubagent = kind === "subagent-call" || part.toolName.startsWith("eve:subagent:");
  const displayName = part.toolName.replace(/^eve:subagent:/, "");
  const running = TOOL_STATE_RUNNING.has(part.state);
  const hasDetail =
    ("input" in part && part.input !== undefined) ||
    ("output" in part && part.output !== undefined) ||
    ("errorText" in part && Boolean(part.errorText));

  return (
    <div className="w-full overflow-hidden rounded-xl border border-stone-200 bg-white">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors ${hasDetail ? "hover:bg-stone-50" : "cursor-default"}`}
      >
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            isSubagent ? "bg-amber-50 text-amber-600" : "bg-teal-50 text-teal-600"
          }`}
        >
          {isSubagent ? <GitBranch size={14} /> : <Terminal size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="mono truncate text-[12.5px] font-semibold text-stone-800">{displayName}</span>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                TOOL_STATE_STYLE[part.state] ?? "bg-stone-100 text-stone-500"
              }`}
            >
              {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
              {TOOL_STATE_LABEL[part.state] ?? part.state}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] text-stone-400">{isSubagent ? "Subagent call" : "Tool call"}</span>
        </span>
        {hasDetail && (
          <span className="shrink-0 text-stone-400 transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }}>
            <ChevronDown size={15} />
          </span>
        )}
      </button>

      {open && hasDetail && (
        <div className="flex flex-col gap-3 border-t border-stone-100 bg-stone-50/60 px-3.5 py-3">
          {"input" in part && part.input !== undefined && (
            <Field label="Input">
              <JsonView value={part.input} />
            </Field>
          )}
          {"output" in part && part.output !== undefined && (
            <Field label="Output">
              <JsonView value={part.output} />
            </Field>
          )}
          {"errorText" in part && part.errorText && (
            <Field label="Error">
              <span className="text-rose-600">{part.errorText}</span>
            </Field>
          )}
        </div>
      )}

      {request && part.state === "approval-requested" && (
        <div className="flex items-center gap-3 border-t border-stone-100 bg-amber-50/40 px-3.5 py-2.5">
          <span className="text-xs leading-relaxed text-stone-600">{request.prompt}</span>
          <div className="ml-auto flex shrink-0 gap-2">
            {(request.options ?? [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }]).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => void agent.send({ inputResponses: [{ requestId: request.requestId, optionId: option.id }] })}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  option.style === "danger"
                    ? "border-rose-300 text-rose-600 hover:bg-rose-50"
                    : "border-teal-300 text-teal-700 hover:bg-teal-50"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">{label}</div>
      <div className="mono overflow-x-auto rounded-lg border border-stone-200 bg-white p-3 text-[11.5px] leading-relaxed">
        {children}
      </div>
    </div>
  );
}
