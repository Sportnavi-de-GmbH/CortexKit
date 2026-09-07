"use client";

// Navio Plus widget — the menu-based FAQ + contact bot, built to
// docs/design/NAVIO_PLUS_WIDGET_SPEC.md. Screens: launcher (public/launcher.js) →
// greeting → consent → MENU → FAQ chat | Kontaktformular → success; ⓘ → info.
// This component is the in-iframe shell (header/body/footer, dark-mode toggle,
// bilingual DE/EN copy) orchestrating the screens; the FAQ chat lives in ChatBody,
// the menu in NavioMenu, the contact form in KontaktForm. Business logic (the eve
// agent) is passed in via `agent`; this file is design + flow only.

import { FeedbackControls } from "./FeedbackControls";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Info,
  Lock,
  MapPin,
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
// The SAME cap the API enforces (agent/channels/eve.ts + the /api/partner
// route), so the counter never promises what the server would reject.
import {
  MAX_MESSAGE_CHARS,
  MESSAGE_COUNTER_VISIBLE_AT,
  isMessageTooLong,
  messageLength,
  nearLimitParts,
  tooLongParts,
} from "@/lib/message-limits";
import { NavioMenu } from "./NavioMenu";
import { PRIVACY_URL } from "./links";
import { SportnaviLogo } from "./SportnaviLogo";
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


// Public Microsoft Bookings link for the "Termin buchen" menu card. No default —
// unset means the card is hidden (NavioMenu only renders it when a handler is given).
const BOOKING_URL = process.env.NEXT_PUBLIC_BOOKING_URL || null;

const QUICK_REPLIES = [
  "Angebote finden",
  "Wie checke ich ein?",
  "Partner werden",
  "Sportnavi für Firmen",
];

// Intro copy, split into the three levels the composition needs. The waving-hand
// emoji is gone: the design system bans emoji as UI furniture, and a brand tile with
// a line icon does the same job without looking like a 2016 chatbot.
const INTRO_CHAT = {
  title: "Hi, ich bin Navio",
  de: "Dein Guide durch die Sportnavi Welt. Wobei kann ich dir helfen?",
  en: "Your guide through the Sportnavi world. How can I help you?",
} as const;

const INTRO_PARTNER = {
  title: "Partner finden",
  de: "Sag mir, wo und was du trainieren willst – z. B. „Yoga in Bochum“.",
  en: "Tell me where and what you want to train — e.g. “Yoga in Bochum”.",
} as const;
const PARTNER_QUICK_REPLIES = [
  "Yoga in Bochum",
  "Klettern für Anfänger",
  "Fitnessstudio in Bielefeld",
  "Reha-Sport in meiner Nähe",
];

// Per-chat-screen copy so the FAQ and Partner screens reuse ChatBody/InputBar.
const CHAT_CFG = {
  chat: {
    intro: INTRO_CHAT,
    quickReplies: QUICK_REPLIES,
    placeholder: "Frage Navio …",
  },
  partner: {
    intro: INTRO_PARTNER,
    quickReplies: PARTNER_QUICK_REPLIES,
    placeholder: "Stadt & Sportart, z. B. „Yoga in Bochum“ …",
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

// Opens the Bookings link in a new tab. Never called with a null URL — NavioMenu
// only renders the card when onSelectMeeting is defined.
function openBooking() {
  if (BOOKING_URL) window.open(BOOKING_URL, "_blank", "noopener,noreferrer");
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
    // The disabled send button covers the click path; this covers every other
    // one (Enter, a quick reply) and keeps the draft intact so the visitor can
    // shorten it rather than losing what they wrote.
    if (isMessageTooLong(trimmed)) return;
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
      {/* ONE header, one shape, on every screen.
          It was two stacked bars — a white logo strip over a solid brand-green slab
          — costing ~100px of chrome and putting white text on #95c11e at 1.9:1. The
          green is gone from the chrome entirely and now survives only where it MEANS
          something: the online dot, the send button, selected states, focus rings.
          Every screen carries the same lockup: logo on its own line, status beneath.
          Sub-screens only add the back button in front, so the brand never changes
          size or position as you move through the widget. */}
      <header className="border-b border-(--border) bg-(--surface) text-(--fg)">
        {/* gap-2 rather than gap-3 so back + a 30px logo + three 32px controls still
            fit a 320px phone (measured: 315 of 320). */}
        <div className="mx-auto flex w-full max-w-[452px] items-center gap-2 px-4 py-3.5">
          {showBack && (
            <button
              type="button"
              aria-label="Zurück zum Menü"
              onClick={() => setScreen("menu")}
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-(--border) text-(--fg-muted) transition-colors hover:bg-(--surface-muted) hover:text-(--fg) after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
            >
              <ArrowLeft size={18} strokeWidth={1.75} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <SportnaviLogo height={30} />
            <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-(--fg-subtle)">
              {header.dot && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--brand-green)" aria-hidden="true" />
              )}
              <span className="truncate">
                {header.subtitle ? `${header.title} · ${header.subtitle}` : header.title}
              </span>
            </span>
          </div>
          <HeaderBtn label={theme === "dark" ? "Helles Design" : "Dunkles Design"} onClick={toggle}>
            {theme === "dark" ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
          </HeaderBtn>
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
        </div>
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
          onSelectMeeting={BOOKING_URL ? openBooking : undefined}
        />
      )}
      {isChatScreen && (
        <ChatBody
          agent={activeAgent}
          isBusy={isBusy}
          messages={messages}
          onQuickReply={send}
          intro={cfg.intro}
          quickReplies={cfg.quickReplies}
          // Which agent answered — the two chat screens share this component but
          // trace to two DIFFERENT Langfuse projects, so feedback has to say
          // which one it belongs to.
          surface={screen === "partner" ? "partner" : "faq"}
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
          className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-(--fg-muted) transition-colors hover:bg-(--surface-muted) hover:text-(--fg)"
        >
          <Lock size={12} strokeWidth={2} className="text-(--fg-subtle)" aria-hidden="true" />
          <span className="underline decoration-(--fg-subtle)/60 underline-offset-4">
            Datenschutz · Privacy Policy
          </span>
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
      // 32px circle, but a 44x44 hit area centred on it via ::after — the visual
      // rhythm of the header is unchanged while the tap target clears the mobile
      // minimum, which matters once launcher.js goes full-screen on phones.
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-(--surface-muted) hover:text-(--fg) after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
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
  intro,
  quickReplies,
  surface,
}: {
  agent: Agent;
  isBusy: boolean;
  messages: EveMessageData["messages"];
  onQuickReply: (text: string) => void;
  intro: { title: string; de: string; en: string };
  quickReplies: readonly string[];
  surface: "faq" | "partner";
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, isBusy]);

  const showQuickReplies = messages.length === 0;
  const waiting = agent.status === "submitted";

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2.5">
      {/* The intro is a COMPOSITION, not a chat bubble.
          It used to be a grey bubble holding a 
-joined bilingual blob with a
          waving-hand emoji, so the assistant's identity was indistinguishable from
          any other message. Now: brand tile, headline, German line, subordinate
          English — the three levels the bilingual rule in §4 asks for, arranged.
          It only shows while the thread is empty; once a conversation starts it
          scrolls away and the messages take over. */}
      {showQuickReplies && (
        <div className="flex flex-col items-center px-2 pt-3 pb-1 text-center">
          <span
            className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--brand-green) text-(--ink)"
            aria-hidden="true"
          >
            {surface === "partner" ? (
              <MapPin size={26} strokeWidth={1.75} />
            ) : (
              <Bot size={26} strokeWidth={1.75} />
            )}
          </span>
          <h2 className="mt-3.5 font-headline text-lg font-semibold tracking-[-0.01em] text-(--fg)">
            {intro.title}
          </h2>
          <p className="mt-1.5 max-w-[30ch] text-[13px] leading-relaxed text-(--fg-muted)">
            {intro.de}
          </p>
          <p className="mt-1 max-w-[32ch] text-[11px] leading-relaxed text-(--fg-subtle)">
            {intro.en}
          </p>
        </div>
      )}

      {showQuickReplies && (
        <div className="flex flex-wrap justify-center gap-2 pt-2 pb-1">
          {quickReplies.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onQuickReply(q)}
              className="min-h-[32px] rounded-full border border-(--border) bg-(--surface) px-3.5 text-[13px] text-(--fg-muted) transition-colors hover:border-(--fg)/25 hover:bg-(--surface-muted) hover:text-(--fg)"
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
            className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-[15px] leading-[1.5]"
            style={{ background: "var(--user-bubble)", color: "var(--user-bubble-fg)" }}
          >
            <p className="whitespace-pre-wrap wrap-break-word">{messageText(m)}</p>
          </div>
        ) : (
          <div key={m.id}>
            <BotBubble>
              <Markdown text={messageText(m)} />
              {m.metadata?.status === "streaming" && <Cursor />}
            </BotBubble>
            {/* Only once the answer is finished: rating a half-written reply is
                meaningless, and `turnId` is what ties it to the Langfuse trace. */}
            {m.metadata?.status === "complete" && (
              <FeedbackControls
                sessionId={agent.session?.sessionId}
                turnId={m.metadata?.turnId}
                surface={surface}
              />
            )}
          </div>
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
    </div>
  );
}

function BotBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[92%] rounded-2xl rounded-tl-sm bg-(--surface-muted) px-4 py-3.5 text-[15px] leading-[1.65] text-(--fg)">
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

/**
 * The composer. Enforces the SHARED message cap (lib/message-limits.ts) that the
 * server enforces too, so what the counter promises is what the API accepts.
 *
 * Deliberately NOT a hard `maxlength` on the input: truncating a paste silently
 * discards the visitor's text and leaves them wondering what happened. Instead
 * the text is kept, the send button is disabled, and the overflow is named with
 * the exact number of characters to remove.
 */
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
  const count = messageLength(draft);
  const tooLong = count > MAX_MESSAGE_CHARS;
  // Hidden while the visitor has plenty of room — a counter on every message is
  // noise; one that appears as the limit nears is information.
  const showCounter = count >= MESSAGE_COUNTER_VISIBLE_AT;
  const canSend = !disabled && count > 0 && !tooLong;
  const hint = tooLong ? tooLongParts(draft) : nearLimitParts(draft);
  return (
    <div className="border-t border-(--border)">
    <form
      className="mx-auto flex w-full max-w-[584px] flex-col gap-1.5 px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <div className="flex w-full items-center gap-2">
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
        aria-invalid={tooLong || undefined}
        aria-describedby={showCounter ? "navio-input-status" : undefined}
        className={`min-h-[40px] flex-1 rounded-full border bg-(--surface) px-4 py-2 text-sm text-(--fg) transition-colors placeholder:text-(--fg-subtle) focus:outline-none focus:ring-2 disabled:opacity-70 ${
          tooLong
            ? "border-(--brand-orange) focus:border-(--brand-orange) focus:ring-(--brand-orange)/30"
            : "border-(--border) focus:border-(--brand-green) focus:ring-(--brand-green)/30"
        }`}
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Senden"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--brand-green) text-(--ink) transition-transform hover:scale-[1.04] active:scale-95 disabled:scale-100 disabled:bg-(--surface-muted) disabled:text-(--fg-subtle)"
      >
        <Send size={16} strokeWidth={1.75} />
      </button>
      </div>

      {/* One live region for both states: a quiet "N left" while there is room,
          a soft-tinted note with the exact overflow once past the cap. `polite`
          so a screen reader is not interrupted on every keystroke. */}
      {showCounter && (
        <div
          id="navio-input-status"
          role="status"
          aria-live="polite"
          className={`flex items-center gap-2.5 rounded-2xl px-3 py-2 text-xs transition-colors duration-200 ${
            tooLong ? "bg-(--brand-orange)/10" : "bg-transparent"
          }`}
        >
          {tooLong && (
            <AlertCircle
              size={14}
              strokeWidth={2}
              className="mt-px shrink-0 text-(--brand-orange)"
              aria-hidden="true"
            />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
            <span className={tooLong ? "text-(--brand-orange)" : "text-(--fg-subtle)"}>
              {hint.de}
            </span>
            <span className={tooLong ? "text-(--brand-orange)/70" : "text-(--fg-subtle)/70"}>
              {hint.en}
            </span>
          </span>

          {/* Counter as a compact pill with a fill bar: the number is exact, the
              bar is the glanceable version of it. */}
          <span
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 tabular-nums transition-colors duration-200 ${
              tooLong
                ? "bg-(--brand-orange)/15 font-semibold text-(--brand-orange)"
                : "bg-(--surface-muted) text-(--fg-muted)"
            }`}
          >
            <span
              aria-hidden="true"
              className="hidden h-1 w-8 overflow-hidden rounded-full bg-(--border) sm:block"
            >
              <span
                className={`block h-full rounded-full transition-[width,background-color] duration-200 ${
                  tooLong ? "bg-(--brand-orange)" : "bg-(--brand-green)"
                }`}
                style={{ width: `${Math.min(100, (count / MAX_MESSAGE_CHARS) * 100)}%` }}
              />
            </span>
            {count}/{MAX_MESSAGE_CHARS}
          </span>
        </div>
      )}
    </form>
    </div>
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

/** Bot replies as styled markdown (spec §6): links, lists, code, tables. */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-(--fg)">{children}</strong>,
        // Ink text with a thick GREEN underline: unmistakably a link and on-brand,
        // without ever using green as body text (~1.9:1 on the bubble). The
        // underline thickens on hover so the affordance survives a colour-blind read.
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-(--fg) decoration-(--brand-green) decoration-2 underline underline-offset-[3px] transition-[text-decoration-color,background-color] hover:bg-(--brand-green)/15 hover:decoration-(--fg)"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="mb-3 flex list-disc flex-col gap-2 pl-5 marker:font-semibold marker:text-(--fg) last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 flex list-decimal flex-col gap-2 pl-5 marker:font-semibold marker:text-(--fg) last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed [&>p]:mb-0">{children}</li>,
        h1: ({ children }) => <h4 className="mt-5 mb-2 font-headline text-base font-semibold first:mt-0">{children}</h4>,
        h2: ({ children }) => <h4 className="mt-5 mb-2 font-headline text-base font-semibold first:mt-0">{children}</h4>,
        h3: ({ children }) => <h4 className="mt-5 mb-2 font-headline text-base font-semibold first:mt-0">{children}</h4>,
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
