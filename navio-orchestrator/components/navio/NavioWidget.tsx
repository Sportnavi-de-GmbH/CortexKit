"use client";

// Navio Plus widget — the MULTI-AGENT version, chat-first.
//
// One chat, one master agent, NO menu (docs/superpowers/specs/
// 2026-09-08-chat-first-redesign.md). Consent leads straight into the
// conversation; the master classifies every message and routes it to the faq
// subagent, the find_partners tool (partner agent service), the approval-gated
// request_human_contact escalation, or provide_booking_link. The visitor never
// picks an agent and never learns there are several.
//
// The visual shell (header with the Sportnavi lockup, mascot greeting card,
// intro composition, footer) follows kb-agent-langsmith-starter's design.
//
// What is load-bearing in here:
//   - ApprovalPrompt: `ask_question` and the approval-gated escalation park the
//     turn with ZERO message.appended events; a client that ignores
//     `input.requested` shows an empty bubble forever.
//   - Marker parsing: specialist answers end with `[[action:…]]`/`[[notice:…]]`
//     lines that the master relays verbatim (instructions.md R7). Every render
//     strips them (streaming included — a half-written `[[` must not flicker)
//     and, once the answer is complete, renders them as the quick-action chips.
//   - Typing dots stay visible while streaming-with-no-visible-text — a partner
//     search is 30–60s of silence and must not look like a hang. Computed on the
//     PARSED text, so a stream that begins with a marker still shows the dots.
//
// Design rules are unchanged (docs/design/WIDGET-DESIGN-GUIDELINES.md):
// green = AI action, orange = human hand-off, no third brand colour.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
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
import { MessageActions } from "./MessageActions";
import { DataNotice } from "./DataNotice";
import { parseMessageActions, resolveActions } from "../../lib/navio-actions";
import { currentTurnDelegationFrom } from "../../lib/specialist-preview";
import { useSpecialistPreview } from "./useSpecialistPreview";
// The SAME cap the API enforces (agent/channels/eve.ts), so the counter never
// promises what the server would reject.
import {
  MAX_MESSAGE_CHARS,
  MESSAGE_COUNTER_VISIBLE_AT,
  isMessageTooLong,
  messageLength,
  nearLimitParts,
  tooLongParts,
} from "../../lib/message-limits";
import { PRIVACY_URL } from "./links";
import { SportnaviLogo } from "./SportnaviLogo";
import { NavioLogo } from "./NavioLogo";

type Agent = UseEveAgentHelpers<EveMessageData>;
type Screen = "greeting" | "consent" | "chat" | "contact" | "info";

/** Header title/subtitle per screen. */
const HEADER: Record<
  Exclude<Screen, "greeting">,
  { title: string; subtitle: string | null; dot: boolean }
> = {
  consent: { title: "Navio Plus", subtitle: "Online", dot: true },
  chat: { title: "Navio Plus", subtitle: "Online", dot: true },
  contact: { title: "Kontakt aufnehmen", subtitle: "Antwort in 1–2 Werktagen", dot: false },
  info: { title: "Über Navio Plus", subtitle: null, dot: false },
};

// Public Microsoft Bookings link for the "Termin buchen" chip. No default — unset
// means the chip is dropped (MessageActions only renders it when a URL is given).
// This is the CLIENT-side twin of the server-only BOOKING_URL that
// agent/tools/provide_booking_link.ts relays in-chat.
const BOOKING_URL = process.env.NEXT_PUBLIC_BOOKING_URL || null;

// With no menu, the intro + these quick replies are the ONLY things telling a new
// visitor what Navio can do. Keep the mix: two knowledge questions, two partner
// searches. They double as a live routing smoke test.
const QUICK_REPLIES = [
  "Was ist Firmenfitness?",
  "Wie checke ich ein?",
  "Yoga in Bochum",
  "Fitnessstudio in Bielefeld",
];

const INTRO = {
  title: "Hi, ich bin Navio",
  de: "Ich beantworte deine Fragen rund um Sportnavi und finde Studios & Kurse in deiner Nähe.",
  en: "I answer your Sportnavi questions and find studios & classes near you.",
} as const;

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

/**
 * Turns that actually ran a partner search.
 *
 * `action.result` events carry the `turnId` of the turn they belong to, and every
 * assistant message carries `metadata.turnId` — so this is how the widget knows an
 * answer came from `find_partners` WITHOUT trusting the marker line, which the R7
 * relay can drop. Answers of these turns always get the "Studios durchsuchen"
 * chip (owner requirement 2026-09-08).
 */
function partnerTurnIds(agent: Agent): Set<string> {
  const turns = new Set<string>();
  for (const raw of agent.events) {
    const event = raw as { type?: string; data?: { turnId?: string } };
    if (event.type !== "action.result") continue;
    if (!JSON.stringify(event.data ?? {}).includes("find_partners")) continue;
    if (typeof event.data?.turnId === "string") turns.add(event.data.turnId);
  }
  return turns;
}

export function NavioWidget({ agent }: { agent: Agent }) {
  const { theme, toggle } = useNavioTheme();
  const [screen, setScreen] = useState<Screen>("greeting");
  const [declined, setDeclined] = useState(false);
  const [draft, setDraft] = useState("");
  // Which contact-form-open signal we already acted on, so returning to the chat
  // doesn't immediately bounce the user back into the form.
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
    // The disabled send button covers the click path; this covers every other
    // one (Enter, a quick reply) and keeps the draft intact so the visitor can
    // shorten it rather than losing what they wrote.
    if (isMessageTooLong(trimmed)) return;
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
  // Back returns to the CHAT — the chat is the home screen now.
  const showBack = screen === "contact" || screen === "info";

  return (
    <div className={root}>
      {/* ONE header, one shape, on every screen (reference design). The green
          survives only where it MEANS something: the online dot, the send button,
          selected states, focus rings. */}
      <header className="border-b border-(--border) bg-(--surface) text-(--fg)">
        <div className="mx-auto flex w-full max-w-[452px] items-center gap-2 px-4 py-3.5">
          {showBack && (
            <button
              type="button"
              aria-label="Zurück zum Chat"
              onClick={() => setScreen("chat")}
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
          {screen === "chat" && (
            <>
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
        </div>
      </header>

      {/* Body — the only scroll region */}
      {screen === "consent" && (
        <ConsentGate declined={declined} onAccept={() => setScreen("chat")} onDecline={() => setDeclined(true)} />
      )}
      {screen === "chat" && (
        <ChatBody
          agent={agent}
          isBusy={isBusy}
          messages={messages}
          inputRequest={inputRequest}
          onQuickReply={send}
          onScreen={setScreen}
          bookingUrl={BOOKING_URL}
        />
      )}
      {screen === "contact" && <KontaktForm onBack={() => setScreen("chat")} />}
      {screen === "info" && <InfoPanel onBack={() => setScreen("chat")} />}

      {/* Input bar — chat only */}
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

/** Round icon button used across the header. */
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
      <div className="relative w-full max-w-[340px] overflow-hidden rounded-3xl border border-(--border) bg-(--surface) text-(--fg) soft-shadow-lg">
        {/* A single soft green wash bleeding down from behind Navio's head — the
            one decorative flourish on this screen, kept a tint so it reads on the
            light and the dark surface alike. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-(--brand-green)/12 to-transparent"
        />

        <div className="absolute top-3 right-3 z-10 flex gap-1">
          <button
            type="button"
            aria-label={theme === "dark" ? "Helles Design" : "Dunkles Design"}
            onClick={onToggleTheme}
            className="flex h-7 w-7 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-(--fg)/5 hover:text-(--fg)"
          >
            {theme === "dark" ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            aria-label="Schließen"
            onClick={closeWidget}
            className="flex h-7 w-7 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-(--fg)/5 hover:text-(--fg)"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>

        <div className="relative flex flex-col items-center px-6 pt-8 pb-6 text-center">
          {/* Navio's face, on a green halo so the dark badge has something to sit
              in on the light surface and does not read as a hole in the card. */}
          <span
            aria-hidden="true"
            className="flex h-[88px] w-[88px] items-center justify-center rounded-full bg-(--brand-green)/15"
          >
            <NavioLogo size={72} />
          </span>

          <h1 className="mt-4 font-headline text-[19px] leading-tight font-semibold text-(--fg)">
            Hi, ich bin Navio 👋🏻
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-(--fg-muted)">
            Dein Guide durch die Sportnavi Welt. Stell deine Fragen und bekomm schnelle Antworten. 💚
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-(--fg-subtle)">
            Your guide through the Sportnavi world — ask away and get answers fast.
          </p>

          {/* The vouching line: Navio is the character; Sportnavi stands behind it. */}
          <div className="mt-5 flex w-full items-center gap-3">
            <span className="h-px flex-1 bg-(--border)" aria-hidden="true" />
            <span className="flex items-center gap-2 text-[11px] text-(--fg-subtle)">
              von
              <SportnaviLogo height={15} />
            </span>
            <span className="h-px flex-1 bg-(--border)" aria-hidden="true" />
          </div>

          <button
            type="button"
            onClick={onStart}
            // Ink, not white: `#95c11e` carries white text at 1.9:1 and ink at
            // 8.5:1 (design guidelines §3/§6.4).
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-(--brand-green) px-4 py-3 text-sm font-semibold text-(--ink) transition-transform hover:scale-[1.02] active:scale-100"
          >
            <MessageSquare size={18} strokeWidth={2} />
            Mit Navio chatten
            <ArrowRight size={18} strokeWidth={2} />
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

/* ── Screen 3 — the chat ──────────────────────────────────────────────────── */

function ChatBody({
  agent,
  isBusy,
  messages,
  inputRequest,
  onQuickReply,
  onScreen,
  bookingUrl,
}: {
  agent: Agent;
  isBusy: boolean;
  messages: EveMessageData["messages"];
  inputRequest: ReturnType<typeof pendingInputRequest>;
  onQuickReply: (text: string) => void;
  onScreen: (screen: "contact") => void;
  bookingUrl: string | null;
}) {
  // The "early answer": specialist content lifted off the wire (live FAQ child
  // stream / finished find_partners result) while the master is still relaying.
  // Shown in place of the typing dots, so the visitor reads the answer 5–20s
  // before the relay finishes re-typing it.
  const previewRaw = useSpecialistPreview(agent);
  const preview = useMemo(
    () => (previewRaw ? parseMessageActions(previewRaw).text : ""),
    [previewRaw],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, isBusy, inputRequest, preview]);

  // Which turns ran find_partners — event-based, so it survives a relay that
  // dropped the marker line.
  const partnerTurns = useMemo(() => partnerTurnIds(agent), [agent.events.length]);

  const showQuickReplies = messages.length === 0;

  // Typing dots show while SUBMITTED *and* while streaming-with-no-VISIBLE-text.
  // Computed on the PARSED text: a stream whose first chunk is a half-written
  // marker (`[[`) renders an empty bubble, and the dots must not vanish then.
  const lastMessage = messages.at(-1);
  const streamingWithoutText =
    agent.status === "streaming" &&
    (lastMessage?.role !== "assistant" ||
      parseMessageActions(messageText(lastMessage)).text.trim().length === 0);
  const waiting = agent.status === "submitted" || streamingWithoutText;

  // When to show the preview: from its first content until the RELAY's text
  // appears. `waiting` is the wrong gate — it closes as soon as the master's
  // announcement text exists, which is exactly the window the preview fills.
  // The baseline is the number of VISIBLE assistant answers at first preview
  // content; one more after that is the relay's text arriving, and the preview
  // yields to the real bubble.
  const visibleAnswers = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.role === "assistant" &&
          parseMessageActions(messageText(m)).text.trim().length > 0,
      ).length,
    [messages],
  );
  const previewBaseline = useRef<number | null>(null);
  useEffect(() => {
    if (!isBusy) {
      previewBaseline.current = null;
      return;
    }
    if (preview && previewBaseline.current === null) previewBaseline.current = visibleAnswers;
  }, [preview, isBusy, visibleAnswers]);
  const showPreview =
    isBusy &&
    preview.length > 0 &&
    previewBaseline.current !== null &&
    visibleAnswers <= previewBaseline.current;

  // The UI-side R2 fallback: when the master delegated SILENTLY (measured on
  // ~half of gpt-4o's delegating turns), render the announcement ourselves the
  // moment the delegation appears on the wire (~2-4s) — a prompt rule cannot
  // deliver "always", the UI can. Skipped whenever the master did speak this
  // turn (its own announcement is then the visible last message).
  const masterSpokeThisTurn =
    lastMessage?.role === "assistant" &&
    parseMessageActions(messageText(lastMessage)).text.trim().length > 0;
  const delegation = useMemo(
    () => (isBusy ? currentTurnDelegationFrom(agent.events) : null),
    [agent.events.length, isBusy],
  );
  const announcement =
    waiting && !masterSpokeThisTurn && delegation
      ? delegation === "partner"
        ? "Alles klar, ich suche passende Partner für dich – das dauert einen kleinen Moment. ⏳"
        : "Einen Moment, ich schaue kurz nach."
      : null;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2.5">
        {/* The intro is a COMPOSITION, not a chat bubble: brand tile, headline,
            German line, subordinate English. It only shows while the thread is
            empty; once a conversation starts it scrolls away. */}
        {showQuickReplies && (
          <div className="flex flex-col items-center px-2 pt-3 pb-1 text-center">
            <span
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--brand-green) text-(--ink)"
              aria-hidden="true"
            >
              <Bot size={26} strokeWidth={1.75} />
            </span>
            <h2 className="mt-3.5 font-headline text-lg font-semibold tracking-[-0.01em] text-(--fg)">
              {INTRO.title}
            </h2>
            <p className="mt-1.5 max-w-[30ch] text-[13px] leading-relaxed text-(--fg-muted)">
              {INTRO.de}
            </p>
            <p className="mt-1 max-w-[32ch] text-[11px] leading-relaxed text-(--fg-subtle)">
              {INTRO.en}
            </p>
          </div>
        )}

        {showQuickReplies && (
          <div className="flex flex-wrap justify-center gap-2 pt-2 pb-1">
            {QUICK_REPLIES.map((q) => (
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
          ) : messageText(m).trim().length === 0 ? null : (
            // Assistant messages whose RAW text is empty carry only tool calls —
            // the delegation itself must stay invisible to the user.
            <BotMessage
              key={m.id}
              message={m}
              sessionId={agent.session?.sessionId}
              onScreen={onScreen}
              bookingUrl={bookingUrl}
              chipsDisabled={isBusy || inputRequest !== null}
              partnerTurn={
                typeof m.metadata?.turnId === "string" && partnerTurns.has(m.metadata.turnId)
              }
            />
          ),
        )}

        {/* In order of information value during a running turn: the
            specialist's answer as it arrives (until the relay message takes
            over) → the (UI-guaranteed) announcement of what is being done →
            the dots. */}
        {showPreview && (
          <BotBubble>
            <Markdown text={preview} />
            <Cursor />
          </BotBubble>
        )}
        {!showPreview &&
          waiting &&
          (announcement ? (
            <BotBubble>
              <p className="whitespace-pre-wrap">{announcement}</p>
              <Cursor />
            </BotBubble>
          ) : (
            <TypingIndicator />
          ))}

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
    </div>
  );
}

/**
 * One assistant reply: the bubble, then the freshness notice, then the action
 * chips the specialist asked for, then the feedback thumbs.
 *
 * The marker line is stripped on EVERY render, streaming included — a marker is
 * never something the visitor should read. The chips and notice wait for
 * `status === "complete"`, for the same reason FeedbackControls does: the last
 * line is still arriving, so a row rendered early would grow and reflow under
 * the reader's cursor. A relay that carries ONLY markers still renders its chip
 * row, just without an empty bubble above it.
 */
function BotMessage({
  message,
  sessionId,
  onScreen,
  bookingUrl,
  chipsDisabled,
  partnerTurn,
}: {
  message: EveMessageData["messages"][number];
  sessionId: string | undefined;
  onScreen: (screen: "contact") => void;
  bookingUrl: string | null;
  chipsDisabled: boolean;
  /** True when this message's turn ran find_partners (event-based detection). */
  partnerTurn: boolean;
}) {
  const streaming = message.metadata?.status === "streaming";
  const complete = message.metadata?.status === "complete";
  const { text, actions, notices } = parseMessageActions(messageText(message));
  // The guaranteed chips ride along even when the specialists forgot to ask (or
  // the relay dropped the marker line). Marker hints still count as a partner
  // signal, in case the event has not arrived in this projection yet.
  const partner =
    partnerTurn ||
    notices.includes("data") ||
    actions.includes("studios") ||
    actions.includes("partner");
  const chips = resolveActions(actions, { partner });

  return (
    <div>
      {(text.length > 0 || streaming) && (
        <BotBubble>
          <Markdown text={text} />
          {streaming && <Cursor />}
        </BotBubble>
      )}
      {complete && notices.includes("data") && <DataNotice />}
      {complete && (
        <MessageActions
          actions={chips}
          onScreen={onScreen}
          bookingUrl={bookingUrl}
          disabled={chipsDisabled}
        />
      )}
      {/* Only once the answer is finished: rating a half-written reply is
          meaningless, and `turnId` is what ties it to the Langfuse trace. */}
      {complete && <FeedbackControls sessionId={sessionId} turnId={message.metadata?.turnId} />}
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

/* ── Screen — Info panel ──────────────────────────────────────────────────── */

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

/* ── Input bar ────────────────────────────────────────────────────────────── */

/**
 * The composer. Enforces the SHARED message cap (lib/message-limits.ts) that
 * the server enforces too, so what the counter promises is what the API accepts.
 *
 * Deliberately NOT a hard `maxlength` on the input: truncating a paste silently
 * discards the visitor's text and leaves them wondering what happened. Instead
 * the text is kept, the send button is disabled, and the overflow is named with
 * the exact number of characters to remove — warm and actionable, never "error".
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
            className={`min-h-[40px] flex-1 rounded-full border bg-(--surface) px-4 py-2 text-sm text-(--fg) transition-colors placeholder:text-(--fg-subtle) focus:ring-2 focus:outline-none disabled:opacity-70 ${
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

/** Bot replies as styled markdown: links, lists, code, tables. */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-(--fg)">{children}</strong>,
        // Ink text with a thick GREEN underline: unmistakably a link and on-brand,
        // without ever using green as body text (~1.9:1 on the bubble).
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
