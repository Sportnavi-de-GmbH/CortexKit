"use client";

// Navio widget — the chat-first FAQ bot, built to docs/design/NAVIO_WIDGET_SPEC.md.
// Screens: launcher (in public/launcher.js) → greeting → consent → chat → info.
// This component is the in-iframe app: greeting card, GDPR consent gate, the FAQ
// chat, and the "Über Navio" info overlay, with a brand-green header, privacy
// footer, dark-mode toggle, and bilingual (DE/EN) copy. Business logic (the eve
// agent) is passed in via `agent`; this file is design + flow only.

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  Info,
  Lock,
  MessageSquare,
  Moon,
  RotateCcw,
  Send,
  Sun,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import { useNavioTheme } from "./useNavioTheme";

type Agent = UseEveAgentHelpers<EveMessageData>;
type Screen = "greeting" | "consent" | "chat" | "info";

// Point this at the real Sportnavi privacy page (override via env if needed).
const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL ?? "https://www.sportnavi.de/datenschutz";

const QUICK_REPLIES = [
  "Angebote finden",
  "Wie checke ich ein?",
  "Partner werden",
  "Sportnavi für Firmen",
];

const GREETING_DE = "Hi, ich bin Navio 👋🏻\nDein Guide durch die Sportnavi Welt. Wobei kann ich dir helfen?";
const GREETING_EN = "Hi, I'm Navio 👋🏻\nYour guide through the Sportnavi world. How can I help you?";

const ADVANTAGES: { de: string; en: string }[] = [
  { de: "Schreib in jeder Sprache – Navio antwortet in deiner", en: "Write in any language — Navio replies in yours" },
  { de: "Antwortet nur mit offiziellen Sportnavi-Infos – erfindet nichts", en: "Answers only with official Sportnavi info — never invents" },
  { de: "DSGVO-konform – deine Zustimmung vor jedem Chat", en: "GDPR-compliant — your consent before every chat" },
  { de: "Hilft Mitgliedern, Firmen & Partnern – rund um die Uhr", en: "Helps members, companies & partners — around the clock" },
];

function closeWidget() {
  window.parent?.postMessage("snv-widget-close", "*");
}

export function NavioWidget({ agent }: { agent: Agent }) {
  const { theme, toggle } = useNavioTheme();
  const [screen, setScreen] = useState<Screen>("greeting");
  const [declined, setDeclined] = useState(false);
  const [draft, setDraft] = useState("");

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const messages = agent.data.messages;

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy || screen !== "chat") return;
    setDraft("");
    void agent.send({ message: trimmed });
  }

  function reset() {
    agent.reset();
    setDeclined(false);
    setScreen("consent");
  }

  const themeBtn = (
    <button
      type="button"
      aria-label={theme === "dark" ? "Helles Design" : "Dunkles Design"}
      onClick={toggle}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
    >
      {theme === "dark" ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
    </button>
  );

  return (
    <div
      className={`${theme === "dark" ? "theme-dark " : ""}flex h-screen flex-col bg-(--surface) text-(--fg)`}
    >
      {screen === "greeting" ? (
        <GreetingCard theme={theme} onToggleTheme={toggle} onStart={() => setScreen("consent")} />
      ) : (
        <>
          {/* Header — brand-green shell (spec §2) */}
          <header className="flex items-center gap-3 bg-(--brand-green) px-4 py-3 text-white">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-(--brand-green)" aria-hidden="true">
              <Bot size={20} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-headline text-sm font-semibold leading-tight">Navio — Sportnavi Guide</p>
              <span className="flex items-center gap-1.5 text-xs text-white/85">
                <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden="true" />
                Online
              </span>
            </div>
            {themeBtn}
            <button
              type="button"
              aria-label={screen === "info" ? "Zurück zum Chat" : "Über Navio"}
              onClick={() => setScreen(screen === "info" ? "chat" : "info")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
            >
              <Info size={16} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Chat zurücksetzen"
              onClick={reset}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
            >
              <RotateCcw size={16} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Chat schließen"
              onClick={closeWidget}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </header>

          {/* Body — the only scroll region */}
          {screen === "consent" && (
            <ConsentGate declined={declined} onAccept={() => setScreen("chat")} onDecline={() => setDeclined(true)} />
          )}
          {screen === "chat" && (
            <ChatBody agent={agent} isBusy={isBusy} messages={messages} onQuickReply={send} />
          )}
          {screen === "info" && <InfoPanel onBack={() => setScreen("chat")} />}

          {/* Input bar — shown on consent (disabled) + chat (spec §5, §6) */}
          {(screen === "consent" || screen === "chat") && (
            <InputBar
              draft={draft}
              setDraft={setDraft}
              onSend={() => send(draft)}
              disabled={screen === "consent" || isBusy}
              placeholder={screen === "consent" ? "Bitte Datenschutz akzeptieren" : "Frage Navio …"}
            />
          )}

          {/* Privacy footer — constant on the panel */}
          <footer className="border-t border-(--border) bg-(--surface) px-4 py-2 text-center">
            <a
              href={PRIVACY_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-(--fg-subtle) underline underline-offset-2 hover:text-(--fg)"
            >
              Datenschutz · Privacy Policy
            </a>
          </footer>
        </>
      )}
    </div>
  );
}

/* ── Screen 1 — Greeting card ─────────────────────────────────────────────── */

function GreetingCard({
  theme,
  onToggleTheme,
  onStart,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onStart: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-3">
      <div className="w-full max-w-[340px] overflow-hidden rounded-3xl border border-(--border) bg-(--surface) text-(--fg) soft-shadow-lg">
        <div className="flex items-start gap-3 p-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-(--accent-dim) text-(--brand-green)" aria-hidden="true">
            <Bot size={24} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-headline text-base font-semibold text-(--fg)">Hi, ich bin Navio 👋🏻</p>
            <p className="mt-1 text-sm leading-relaxed text-(--fg-muted)">
              Dein Guide durch die Sportnavi Welt. Stell deine Fragen und bekomm schnelle Antworten. 💚
            </p>
            <p className="mt-1 text-xs leading-relaxed text-(--fg-subtle)">
              Your guide through the Sportnavi world — ask away and get answers fast.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              aria-label={theme === "dark" ? "Helles Design" : "Dunkles Design"}
              onClick={onToggleTheme}
              className="flex h-7 w-7 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-black/5 hover:text-(--fg)"
            >
              {theme === "dark" ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
            </button>
            <button
              type="button"
              aria-label="Schließen"
              onClick={closeWidget}
              className="flex h-7 w-7 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-black/5 hover:text-(--fg)"
            >
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <div className="px-5 pb-5">
          <button
            type="button"
            onClick={onStart}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-(--brand-green) px-4 py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02]"
          >
            <MessageSquare size={18} strokeWidth={1.75} />
            Mit Navio chatten
            <ArrowRight size={18} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Screen 2 — Consent gate ──────────────────────────────────────────────── */

function ConsentGate({
  declined,
  onAccept,
  onDecline,
}: {
  declined: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="rounded-2xl border border-(--border) bg-(--surface) p-4 soft-shadow">
        <div className="flex items-center gap-2">
          <Lock size={16} strokeWidth={1.75} className="text-(--brand-orange)" aria-hidden="true" />
          <span className="font-headline text-sm font-semibold text-(--fg)">Datenschutzhinweis</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-(--fg-muted)">
          Um dir bestmöglich zu helfen, verarbeitet Navio deine Eingaben. Weitere Details findest du in unserer
          Datenschutzerklärung.
        </p>
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-(--fg) underline underline-offset-2 hover:text-(--brand-green)"
        >
          Zur Datenschutzerklärung / Privacy Policy
          <ArrowRight size={14} strokeWidth={1.75} />
        </a>
        {declined && (
          <p className="mt-3 text-xs text-(--brand-orange)">
            Ohne deine Zustimmung kann Navio leider nicht antworten.
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onAccept}
            className="flex-1 rounded-full bg-(--brand-green) px-4 py-2 text-sm font-medium text-white transition-transform hover:scale-[1.02]"
          >
            Zustimmen
          </button>
          <button
            type="button"
            onClick={onDecline}
            className="flex-1 rounded-full border border-(--border) px-4 py-2 text-sm text-(--fg) transition-colors hover:border-black/30"
          >
            Ablehnen
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Screen 3 — FAQ chat ──────────────────────────────────────────────────── */

function ChatBody({
  agent,
  isBusy,
  messages,
  onQuickReply,
}: {
  agent: Agent;
  isBusy: boolean;
  messages: EveMessageData["messages"];
  onQuickReply: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, isBusy]);

  const showQuickReplies = messages.length === 0;
  const waiting = agent.status === "submitted";

  return (
    <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
      {/* Static bilingual greeting bubble */}
      <BotBubble>
        <p className="whitespace-pre-wrap">{GREETING_DE}</p>
        <p className="mt-2 whitespace-pre-wrap text-(--fg-subtle)">{GREETING_EN}</p>
      </BotBubble>

      {showQuickReplies && (
        <div className="flex flex-wrap gap-2 pt-1">
          {QUICK_REPLIES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onQuickReply(q)}
              className="rounded-full border border-(--border) bg-(--surface) px-3 py-1 text-xs text-(--fg-muted) transition-colors hover:border-black/30 hover:text-(--fg)"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {messages.map((m) =>
        m.role === "user" ? (
          <div
            key={m.id}
            className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm"
            style={{ background: "var(--user-bubble)", color: "var(--user-bubble-fg)" }}
          >
            <p className="whitespace-pre-wrap wrap-break-word">{messageText(m)}</p>
          </div>
        ) : (
          <BotBubble key={m.id}>
            <Markdown text={messageText(m)} />
            {m.metadata?.status === "streaming" && <Cursor />}
          </BotBubble>
        ),
      )}

      {waiting && <TypingIndicator />}

      {agent.status === "error" && agent.error && (
        <div
          role="alert"
          className="max-w-[88%] rounded-2xl rounded-tl-sm border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700 wrap-break-word"
        >
          {agent.error.message}
        </div>
      )}
    </div>
  );
}

function BotBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-(--surface-muted) px-3.5 py-2.5 text-sm text-(--fg) leading-relaxed">
      {children}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="w-fit rounded-2xl rounded-tl-sm bg-(--surface-muted) px-3.5 py-3">
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--brand-green)"
            style={{ animationDelay: `${i * 0.18}s` }}
            aria-hidden="true"
          />
        ))}
        <span className="sr-only">Navio schreibt …</span>
      </div>
    </div>
  );
}

/* ── Screen 4 — Info panel ────────────────────────────────────────────────── */

function InfoPanel({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      <div>
        <h3 className="font-headline text-base font-semibold text-(--fg)">Über Navio</h3>
        <p className="text-xs text-(--fg-subtle)">About Navio</p>
        <p className="mt-2 text-sm text-(--fg-muted)">
          Navio ist dein freundlicher Guide durch Sportnavi – Deutschlands Firmenfitness-Netzwerk. Stell deine Fragen
          und bekomm schnelle, verlässliche Antworten.
        </p>
        <p className="text-xs text-(--fg-subtle)">
          Navio is your friendly guide through Sportnavi — Germany&apos;s corporate-fitness network. Ask your questions
          and get fast, reliable answers.
        </p>
      </div>

      <div className="space-y-2.5">
        {ADVANTAGES.map((a) => (
          <div key={a.de} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-(--accent-dim) text-(--fg)" aria-hidden="true">
              <Check size={12} strokeWidth={2} />
            </span>
            <span className="text-(--fg-muted)">
              {a.de}
              <span className="block text-xs text-(--fg-subtle)">{a.en}</span>
            </span>
          </div>
        ))}
      </div>

      <p className="text-xs text-(--fg-subtle)">
        Mit der Nutzung stimmst du unserer{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-(--fg)">
          Datenschutzerklärung / Privacy Policy
        </a>{" "}
        zu.
      </p>

      <button
        type="button"
        onClick={onBack}
        className="rounded-full bg-(--fg) px-4 py-2 text-sm lowercase text-(--surface) transition-transform hover:scale-[1.02]"
      >
        zurück zum Chat
      </button>
    </div>
  );
}

/* ── Input bar (shared shell) ─────────────────────────────────────────────── */

function InputBar({
  draft,
  setDraft,
  onSend,
  disabled,
  placeholder,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}) {
  const canSend = !disabled && draft.trim().length > 0;
  return (
    <form
      className="flex items-center gap-2 border-t border-(--border) px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <label htmlFor="navio-input" className="sr-only">
        Frage Navio
      </label>
      <input
        id="navio-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        className="flex-1 rounded-full bg-(--surface-muted) px-4 py-2 text-sm text-(--fg) placeholder:text-(--fg-subtle) focus:outline-none focus:ring-2 focus:ring-[#95c11e]/40 disabled:opacity-70"
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Senden"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--brand-green) text-white transition-opacity disabled:bg-zinc-200 disabled:text-zinc-400"
      >
        <Send size={16} strokeWidth={1.75} />
      </button>
    </form>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function messageText(message: EveMessageData["messages"][number]): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function Cursor() {
  return (
    <span
      className="ml-0.5 inline-block h-3 w-1.5 animate-pulse align-text-bottom"
      style={{ background: "var(--brand-green)" }}
      aria-hidden="true"
    />
  );
}

/** Bot replies as styled markdown (spec §6): green links, lists, code, tables. */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="font-medium text-(--brand-green) underline underline-offset-2 hover:opacity-80">
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="mb-2 flex list-disc flex-col gap-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 flex list-decimal flex-col gap-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed [&>p]:mb-0">{children}</li>,
        h1: ({ children }) => <h4 className="mb-1 mt-2 font-headline text-sm font-semibold first:mt-0">{children}</h4>,
        h2: ({ children }) => <h4 className="mb-1 mt-2 font-headline text-sm font-semibold first:mt-0">{children}</h4>,
        h3: ({ children }) => <h4 className="mb-1 mt-2 font-headline text-sm font-semibold first:mt-0">{children}</h4>,
        code: ({ children, className }) =>
          className ? (
            <code className="mono block overflow-x-auto rounded-lg bg-black/10 p-2.5 text-xs leading-relaxed">{children}</code>
          ) : (
            <code className="mono rounded bg-black/10 px-1.5 py-0.5 text-xs">{children}</code>
          ),
        pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-(--brand-green) pl-3 text-(--fg-muted) last:mb-0">{children}</blockquote>
        ),
        table: ({ children }) => (
          <div className="mb-2 overflow-x-auto rounded-lg border border-(--border) last:mb-0">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border-b border-(--border) px-2.5 py-1.5 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border-b border-(--border) px-2.5 py-1.5 align-top">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
