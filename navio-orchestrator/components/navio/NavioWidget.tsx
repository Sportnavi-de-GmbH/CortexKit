"use client";

// Navio widget — the MULTI-AGENT version. One chat, one agent, no menu.
//
// WHAT CHANGED vs. service 1 (kb-agent-langsmith-starter), and why:
//
//   Screen  = "greeting" | "consent" | "chat" | "contact" | "info"
//   (was)     … | "menu" | "chat" | "partner" | "contact" | …
//
//   - "menu" is GONE. The master agent decides which capability answers, so the
//     user never picks. Discoverability moved into the greeting + quick replies,
//     which now advertise all three capabilities.
//   - "partner" is GONE as a screen. Partner search is a tool on the master, so
//     there is one conversation and one session instead of two independent ones.
//     The `activeAgent` switch and the two `useEveAgent` clients are gone with it.
//   - "contact" is now reached ONLY by the agent's approval-gated escalation, not
//     by a menu card. It still takes over the full panel exactly as before.
//   - ApprovalPrompt is new and load-bearing — see that file.
//
// Design rules are unchanged (docs/design/WIDGET-DESIGN-GUIDELINES.md):
// green = AI action, orange = human hand-off, no third brand colour.

import { useEffect, useMemo, useRef, useState } from "react";
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
import { KontaktForm } from "./KontaktForm";
import { ApprovalPrompt, pendingInputRequest } from "./ApprovalPrompt";
import { FeedbackControls } from "./FeedbackControls";

type Agent = UseEveAgentHelpers<EveMessageData>;
type Screen = "greeting" | "consent" | "chat" | "contact" | "info";

const HEADER: Record<
  Exclude<Screen, "greeting">,
  { title: string; subtitle: string | null; dot: boolean }
> = {
  consent: { title: "Navio Plus", subtitle: "Online", dot: true },
  chat: { title: "Navio Plus", subtitle: "Online", dot: true },
  contact: { title: "Kontakt aufnehmen", subtitle: "Antwort in 1–2 Werktagen", dot: false },
  info: { title: "Über Navio Plus", subtitle: null, dot: false },
};

const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL ?? "https://www.sportnavi.de/datenschutz/";

// With the menu gone, these quick replies are the ONLY thing telling a new
// visitor what Navio can do. Keep the mix: two knowledge questions, two partner
// searches. They double as a live routing smoke test.
const QUICK_REPLIES = [
  "Was ist Firmenfitness?",
  "Wie checke ich ein?",
  "Yoga in Bochum",
  "Fitnessstudio in Bielefeld",
];

const GREETING_DE =
  "Hi, ich bin Navio 👋🏻\nIch beantworte deine Fragen rund um Sportnavi und finde Studios & Kurse in deiner Nähe. Frag einfach los.";
const GREETING_EN =
  "Hi, I'm Navio 👋🏻\nI answer your questions about Sportnavi and find studios & classes near you. Just ask.";

const ADVANTAGES: { de: string; en: string }[] = [
  { de: "Schreib in jeder Sprache – Navio antwortet in deiner", en: "Write in any language — Navio replies in yours" },
  { de: "Antwortet nur mit offiziellen Sportnavi-Infos – erfindet nichts", en: "Answers only with official Sportnavi info — never invents" },
  { de: "DSGVO-konform – deine Zustimmung vor jeder Nutzung", en: "GDPR-compliant — your consent before every use" },
  { de: "Fragen, Partnersuche und Kontakt in einem Chat", en: "Questions, partner search and contact in one chat" },
];

function closeWidget() {
  window.parent?.postMessage("snv-widget-close", "*");
}

/**
 * Did the agent just open the contact form?
 *
 * `request_human_contact` returns `{ openContactForm: true }` — but only AFTER
 * the visitor approved the gate, because the tool is `approval: always()` and
 * eve will not execute it otherwise. So this signal already carries the human's
 * consent; the widget does not re-ask.
 *
 * We read the raw event stream rather than message parts because `action.result`
 * is the authoritative wire event (docs/concepts/sessions-runs-and-streaming.md)
 * and does not depend on how the default reducer projects tool output.
 */
function contactFormRequested(agent: Agent): boolean {
  for (let i = agent.events.length - 1; i >= 0; i--) {
    const event = agent.events[i] as { type?: string; data?: unknown };
    if (event.type !== "action.result") continue;
    const serialized = JSON.stringify(event.data ?? {});
    if (serialized.includes("request_human_contact") && serialized.includes("openContactForm")) {
      return true;
    }
  }
  return false;
}

export function NavioWidget({ agent }: { agent: Agent }) {
  const { theme, toggle } = useNavioTheme();
  const [screen, setScreen] = useState<Screen>("greeting");
  const [declined, setDeclined] = useState(false);
  const [draft, setDraft] = useState("");
  // Which contact-form-open signal we have already acted on, so returning to the
  // chat doesn't immediately bounce the user back into the form.
  const [handledContactAt, setHandledContactAt] = useState(-1);

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const messages = agent.data.messages;

  // The parked-turn prompt (approval or ask_question). While this is set the
  // composer is disabled — eve is waiting on a decision, not on text.
  const inputRequest = useMemo(() => pendingInputRequest(agent), [agent.data.messages]);

  // Agent-driven navigation: escalation approved ⇒ open the form full-panel.
  useEffect(() => {
    if (screen !== "chat") return;
    if (!contactFormRequested(agent)) return;
    if (agent.events.length === handledContactAt) return;
    setHandledContactAt(agent.events.length);
    setScreen("contact");
  }, [agent.events.length, screen, handledContactAt]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy || screen !== "chat" || inputRequest) return;
    setDraft("");
    void agent.send({ message: trimmed });
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
  // Back returns to the CHAT now, not to a menu — the chat is the home screen.
  const showBack = screen === "contact" || screen === "info";

  return (
    <div className={root}>
      <header className="flex items-center gap-3 bg-(--brand-green) px-4 py-3 text-white">
        {showBack ? (
          <button
            type="button"
            aria-label="Zurück zum Chat"
            onClick={() => setScreen("chat")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
        ) : (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-(--brand-green)"
            aria-hidden="true"
          >
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
        {(screen === "consent" || screen === "chat") && (
          <HeaderBtn label={theme === "dark" ? "Helles Design" : "Dunkles Design"} onClick={toggle}>
            {theme === "dark" ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
          </HeaderBtn>
        )}
        {screen === "chat" && (
          <>
            {/* ⓘ lived on the menu before; the chat is the home screen now. */}
            <HeaderBtn label="Über Navio Plus" onClick={() => setScreen("info")}>
              <Info size={16} strokeWidth={1.75} />
            </HeaderBtn>
            <HeaderBtn label="Chat zurücksetzen" onClick={() => agent.reset()}>
              <RotateCcw size={16} strokeWidth={1.75} />
            </HeaderBtn>
          </>
        )}
        <HeaderBtn label="Schließen" onClick={closeWidget}>
          <X size={16} strokeWidth={1.75} />
        </HeaderBtn>
      </header>

      {screen === "consent" && (
        <ConsentGate
          declined={declined}
          onAccept={() => setScreen("chat")}
          onDecline={() => setDeclined(true)}
        />
      )}
      {screen === "chat" && (
        <ChatBody agent={agent} isBusy={isBusy} messages={messages} inputRequest={inputRequest} onQuickReply={send} />
      )}
      {screen === "contact" && <KontaktForm onBack={() => setScreen("chat")} />}
      {screen === "info" && <InfoPanel onBack={() => setScreen("chat")} />}

      {screen === "chat" && (
        <InputBar
          draft={draft}
          setDraft={setDraft}
          onSend={() => send(draft)}
          // While a turn is parked on an approval, the answer is a button press,
          // not text. Disabling the composer makes that unambiguous.
          disabled={isBusy || inputRequest !== null}
          placeholder={inputRequest ? "Bitte wähle oben aus …" : "Frage Navio …"}
        />
      )}

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

/* ── Greeting ─────────────────────────────────────────────────────────────── */

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
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-(--accent-dim) text-(--brand-green)"
            aria-hidden="true"
          >
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

/* ── Consent ──────────────────────────────────────────────────────────────── */

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

/* ── Chat ─────────────────────────────────────────────────────────────────── */

function ChatBody({
  agent,
  isBusy,
  messages,
  inputRequest,
  onQuickReply,
}: {
  agent: Agent;
  isBusy: boolean;
  messages: EveMessageData["messages"];
  inputRequest: ReturnType<typeof pendingInputRequest>;
  onQuickReply: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, isBusy, inputRequest]);

  const showQuickReplies = messages.length === 0;

  // Typing dots show while SUBMITTED *and* while streaming-with-no-text-yet.
  // Service 1 only did the former, which is why a 30–60s partner search looked
  // like a hang (CLAUDE.md §11). The master's "speak before you delegate" rule
  // handles the common case; this covers the gap before the first token.
  const lastMessage = messages.at(-1);
  const streamingWithoutText =
    agent.status === "streaming" &&
    (lastMessage?.role !== "assistant" || messageText(lastMessage).trim().length === 0);
  const waiting = agent.status === "submitted" || streamingWithoutText;

  return (
    <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
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
        ) : messageText(m).trim().length === 0 ? null : (
          // Assistant messages that carry only tool calls render nothing — the
          // delegation itself must stay invisible to the user.
          <div key={m.id}>
            <BotBubble>
              <Markdown text={messageText(m)} />
              {m.metadata?.status === "streaming" && <Cursor />}
            </BotBubble>
            {m.metadata?.status === "complete" && (
              <FeedbackControls sessionId={agent.session?.sessionId} turnId={m.metadata?.turnId} />
            )}
          </div>
        ),
      )}

      {waiting && <TypingIndicator />}

      {/* The parked turn. Rendered LAST so it sits directly above the composer. */}
      {inputRequest && <ApprovalPrompt request={inputRequest} agent={agent} disabled={isBusy} />}

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

/* ── Info ─────────────────────────────────────────────────────────────────── */

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
            <span
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-(--accent-dim) text-(--fg)"
              aria-hidden="true"
            >
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

/* ── Composer ─────────────────────────────────────────────────────────────── */

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

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-(--brand-green) underline underline-offset-2 hover:opacity-80"
          >
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
            <code className="mono block overflow-x-auto rounded-lg bg-black/10 p-2.5 text-xs leading-relaxed">
              {children}
            </code>
          ) : (
            <code className="mono rounded bg-black/10 px-1.5 py-0.5 text-xs">{children}</code>
          ),
        pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-(--brand-green) pl-3 text-(--fg-muted) last:mb-0">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="mb-2 overflow-x-auto rounded-lg border border-(--border) last:mb-0">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-(--border) px-2.5 py-1.5 text-left font-semibold">{children}</th>
        ),
        td: ({ children }) => <td className="border-b border-(--border) px-2.5 py-1.5 align-top">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
