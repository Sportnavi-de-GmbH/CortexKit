"use client";

// Navio Plus widget — the menu-based FAQ + contact bot, built to
// docs/design/NAVIO_PLUS_WIDGET_SPEC.md. Screens: launcher (public/launcher.js) →
// greeting → consent → MENU → FAQ chat | Kontaktformular → success; ⓘ → info.
// This component is the in-iframe shell (header/body/footer, dark-mode toggle,
// bilingual DE/EN copy) orchestrating the screens; the FAQ chat lives in ChatBody,
// the menu in NavioMenu, the contact form in KontaktForm. Business logic (the eve
// agent) is passed in via `agent`; this file is design + flow only.

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
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
import { NavioMenu } from "./NavioMenu";
import { KontaktForm } from "./KontaktForm";

type Agent = UseEveAgentHelpers<EveMessageData>;
type Screen = "greeting" | "consent" | "menu" | "chat" | "partner" | "contact" | "info";

/** Header title/subtitle per screen (Navio Plus, spec §2). */
const HEADER: Record<
  Exclude<Screen, "greeting">,
  { title: string; subtitle: string | null; dot: boolean }
> = {
  consent: { title: "Navio Plus", subtitle: "Online", dot: true },
  menu: { title: "Navio Plus", subtitle: "Online", dot: true },
  chat: { title: "FAQ-Agent", subtitle: "Online", dot: true },
  partner: { title: "Partner-Finder", subtitle: "Online", dot: true },
  contact: { title: "Kontakt aufnehmen", subtitle: "Antwort in 1–2 Werktagen", dot: false },
  info: { title: "Über Navio Plus", subtitle: null, dot: false },
};

// Point this at the real Sportnavi privacy page (override via env if needed).
const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL ?? "https://www.sportnavi.de/datenschutz/";

const QUICK_REPLIES = [
  "Angebote finden",
  "Wie checke ich ein?",
  "Partner werden",
  "Sportnavi für Firmen",
];

const GREETING_DE = "Hi, ich bin Navio 👋🏻\nDein Guide durch die Sportnavi Welt. Wobei kann ich dir helfen?";
const GREETING_EN = "Hi, I'm Navio 👋🏻\nYour guide through the Sportnavi world. How can I help you?";

const PARTNER_GREETING_DE =
  "Sag mir, wo und was du trainieren willst – z. B. 'Yoga in Bochum' 📍\nIch zeige dir passende Sportnavi-Partner in deiner Nähe.";
const PARTNER_GREETING_EN =
  "Tell me where and what you want to train — e.g. 'Yoga in Bochum' 📍\nI'll show you matching Sportnavi partners near you.";
const PARTNER_QUICK_REPLIES = [
  "Yoga in Bochum",
  "Klettern für Anfänger",
  "Fitnessstudio in Bielefeld",
  "Reha-Sport in meiner Nähe",
];

// Per-chat-screen copy so the FAQ and Partner screens reuse ChatBody/InputBar.
const CHAT_CFG = {
  chat: {
    greetingDe: GREETING_DE,
    greetingEn: GREETING_EN,
    quickReplies: QUICK_REPLIES,
    placeholder: "Frage Navio …",
  },
  partner: {
    greetingDe: PARTNER_GREETING_DE,
    greetingEn: PARTNER_GREETING_EN,
    quickReplies: PARTNER_QUICK_REPLIES,
    placeholder: "Stadt & Sportart, z. B. 'Yoga in Bochum' …",
  },
} as const;

const ADVANTAGES: { de: string; en: string }[] = [
  { de: "Schreib in jeder Sprache – Navio antwortet in deiner", en: "Write in any language — Navio replies in yours" },
  { de: "Antwortet nur mit offiziellen Sportnavi-Infos – erfindet nichts", en: "Answers only with official Sportnavi info — never invents" },
  { de: "DSGVO-konform – deine Zustimmung vor jeder Nutzung", en: "GDPR-compliant — your consent before every use" },
  { de: "FAQ-Agent & Kontaktformular in einem Widget", en: "FAQ agent & contact form in one widget" },
];

function closeWidget() {
  window.parent?.postMessage("snv-widget-close", "*");
}

export function NavioWidget({
  faqAgent,
  partnerAgent,
}: {
  faqAgent: Agent;
  partnerAgent: Agent;
}) {
  const { theme, toggle } = useNavioTheme();
  const [screen, setScreen] = useState<Screen>("greeting");
  const [declined, setDeclined] = useState(false);
  const [draft, setDraft] = useState("");

  // The two chat screens ("chat" = FAQ, "partner" = finder) each drive their own eve
  // agent; every message/status/reset below targets whichever screen is active.
  const activeAgent = screen === "partner" ? partnerAgent : faqAgent;
  const isChatScreen = screen === "chat" || screen === "partner";
  const cfg = screen === "partner" ? CHAT_CFG.partner : CHAT_CFG.chat;

  const isBusy = activeAgent.status === "submitted" || activeAgent.status === "streaming";
  const messages = activeAgent.data.messages;

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy || !isChatScreen) return;
    setDraft("");
    void activeAgent.send({ message: trimmed });
  }

  const root = `${theme === "dark" ? "theme-dark " : ""}flex h-screen flex-col bg-(--surface) text-(--fg)`;

  if (screen === "greeting") {
    return (
      <div className={root}>
        <GreetingCard theme={theme} onToggleTheme={toggle} onStart={() => setScreen("consent")} />
      </div>
    );
  }

  const header = HEADER[screen];
  const showBack = isChatScreen || screen === "contact" || screen === "info";

  return (
    <div className={root}>
      {/* Header — brand-green shell (spec §2); left slot + controls vary by screen */}
      <header className="flex items-center gap-3 bg-(--brand-green) px-4 py-3 text-white">
        {showBack ? (
          <button
            type="button"
            aria-label="Zurück zum Menü"
            onClick={() => setScreen("menu")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
        ) : (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-(--brand-green)" aria-hidden="true">
            <Bot size={20} strokeWidth={1.75} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-headline text-sm font-semibold leading-tight">{header.title}</p>
          {header.subtitle && (
            <span className="flex items-center gap-1.5 text-xs text-white/85">
              {header.dot && <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden="true" />}
              {header.subtitle}
            </span>
          )}
        </div>
        {(screen === "consent" || screen === "menu") && (
          <HeaderBtn label={theme === "dark" ? "Helles Design" : "Dunkles Design"} onClick={toggle}>
            {theme === "dark" ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
          </HeaderBtn>
        )}
        {screen === "menu" && (
          <HeaderBtn label="Über Navio Plus" onClick={() => setScreen("info")}>
            <Info size={16} strokeWidth={1.75} />
          </HeaderBtn>
        )}
        {isChatScreen && (
          <HeaderBtn label="Chat zurücksetzen" onClick={() => activeAgent.reset()}>
            <RotateCcw size={16} strokeWidth={1.75} />
          </HeaderBtn>
        )}
        <HeaderBtn label="Schließen" onClick={closeWidget}>
          <X size={16} strokeWidth={1.75} />
        </HeaderBtn>
      </header>

      {/* Body — the only scroll region */}
      {screen === "consent" && (
        <ConsentGate declined={declined} onAccept={() => setScreen("menu")} onDecline={() => setDeclined(true)} />
      )}
      {screen === "menu" && (
        <NavioMenu
          onSelectFaq={() => setScreen("chat")}
          onSelectPartner={() => setScreen("partner")}
          onSelectContact={() => setScreen("contact")}
        />
      )}
      {isChatScreen && (
        <ChatBody
          agent={activeAgent}
          isBusy={isBusy}
          messages={messages}
          onQuickReply={send}
          greetingDe={cfg.greetingDe}
          greetingEn={cfg.greetingEn}
          quickReplies={cfg.quickReplies}
        />
      )}
      {screen === "contact" && <KontaktForm onBack={() => setScreen("menu")} />}
      {screen === "info" && <InfoPanel onBack={() => setScreen("menu")} />}

      {/* Input bar — FAQ chat only */}
      {isChatScreen && (
        <InputBar
          draft={draft}
          setDraft={setDraft}
          onSend={() => send(draft)}
          disabled={isBusy}
          placeholder={cfg.placeholder}
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
    </div>
  );
}

/** Round white/15 icon button used across the header. */
function HeaderBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
    >
      {children}
    </button>
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
  greetingDe,
  greetingEn,
  quickReplies,
}: {
  agent: Agent;
  isBusy: boolean;
  messages: EveMessageData["messages"];
  onQuickReply: (text: string) => void;
  greetingDe: string;
  greetingEn: string;
  quickReplies: readonly string[];
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
        <p className="whitespace-pre-wrap">{greetingDe}</p>
        <p className="mt-2 whitespace-pre-wrap text-(--fg-subtle)">{greetingEn}</p>
      </BotBubble>

      {showQuickReplies && (
        <div className="flex flex-wrap gap-2 pt-1">
          {quickReplies.map((q) => (
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
        <h3 className="font-headline text-base font-semibold text-(--fg)">Über Navio Plus</h3>
        <p className="text-xs text-(--fg-subtle)">About Navio Plus</p>
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
        zurück
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
