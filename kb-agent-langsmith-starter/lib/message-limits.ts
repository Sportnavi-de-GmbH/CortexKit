/**
 * lib/message-limits.ts — the ONE definition of "how long may a chat message be".
 *
 * Imported by BOTH sides so they can never drift apart:
 *   - the widget input bar (components/navio/NavioWidget.tsx) — counter + error
 *     + a disabled send button;
 *   - the public API — agent/channels/eve.ts (FAQ) and the /api/partner proxy
 *     route (partner), which reject an over-long message before the model runs.
 *
 * A client-side cap alone is cosmetic: anyone can POST to /eve/v1/* directly.
 * A server-side cap alone is hostile: the user types a long message and only
 * finds out after sending. Hence both, from this single constant.
 *
 * ── RELATION TO THE EXISTING BYTE CAP ────────────────────────────────────────
 *
 * `NAVIO_MAX_REQUEST_BYTES` (16 KB, agent/channels/eve.ts + lib/partner-proxy.ts)
 * caps the whole HTTP body cheaply, via Content-Length, before it is read. This
 * is a different, finer control: it caps the MESSAGE TEXT itself, so the number
 * shown in the UI is exactly the number the server enforces. The byte cap stays
 * as the outer guard; neither replaces the other.
 *
 * ── WHY `.length` AND NOT GRAPHEMES ──────────────────────────────────────────
 *
 * `String.length` counts UTF-16 code units, so an emoji counts as 2. That is
 * also what the browser's own `maxlength` uses, so the counter the user sees,
 * the check that blocks the button, and the check on the server all agree
 * exactly. A grapheme-accurate count would be friendlier in theory and would
 * silently disagree with the server in practice.
 */

/**
 * Fallback when the env var is unset or unusable.
 *
 * 300 characters ≈ three or four full sentences, which is the shape of a real
 * chat turn: "Ich habe eine Rückenverletzung und suche etwas ganz Sanftes zum
 * Wiedereinstieg in Dortmund" is 92. Navio is a conversation, not a form — a
 * visitor with more to say is better served by a second message (the agent
 * keeps context) than by one wall of text, which also inflates the tokens
 * replayed on every subsequent turn. The contact form, which IS for long-form
 * detail, keeps its own far larger cap (lib/contact/schema.ts).
 */
const DEFAULT_MAX_MESSAGE_CHARS = 300;

/**
 * Maximum characters accepted in a single chat message.
 *
 * `NEXT_PUBLIC_` is load-bearing: Next inlines this variable into the browser
 * bundle AND exposes it to the server, so one value configures both sides. A
 * server-only name would let the two disagree, which is the exact bug this
 * module exists to prevent. Unset, invalid, or non-positive falls back to
 * {@link DEFAULT_MAX_MESSAGE_CHARS}.
 */
export const MAX_MESSAGE_CHARS = ((): number => {
  const raw = Number(process.env.NEXT_PUBLIC_NAVIO_MAX_MESSAGE_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_MESSAGE_CHARS;
})();

/**
 * Point at which the UI starts showing the counter (70% of the budget). A
 * counter on an empty box is clutter; one that appears with room still left is
 * a warning the visitor can act on before losing their flow.
 */
export const MESSAGE_COUNTER_VISIBLE_AT = Math.floor(MAX_MESSAGE_CHARS * 0.7);

/** How the message is measured. Trimmed, so trailing whitespace never blocks a
 *  send that is otherwise within budget — the server trims identically. */
export function messageLength(text: string): number {
  return text.trim().length;
}

/** True when `text` exceeds the cap and must not be sent or accepted. */
export function isMessageTooLong(text: string): boolean {
  return messageLength(text) > MAX_MESSAGE_CHARS;
}

/** Characters still available; negative once the cap is passed. */
export function messageCharsLeft(text: string): number {
  return MAX_MESSAGE_CHARS - messageLength(text);
}

/**
 * What the visitor reads once the cap is passed.
 *
 * Warm, short, and actionable: it never says "error" or "invalid", it names the
 * exact number of characters to remove, and it offers the way forward that
 * actually suits a chat — send it in two messages. Kept to one line so it fits
 * under the input without pushing the conversation around. Bilingual, matching
 * the widget's other visitor-facing copy.
 */
export function tooLongMessage(text: string): string {
  const { de, en } = tooLongParts(text);
  return `${de} · ${en}`;
}

/**
 * The same copy split by language, so the widget can set the visitor's language
 * on its own line and the second one quieter, instead of running both together
 * behind a "·". Same words as {@link tooLongMessage} — that function joins these.
 */
export function tooLongParts(text: string): { de: string; en: string } {
  const over = -messageCharsLeft(text);
  return {
    de: `Das ist etwas viel für einen Chat 😊 Kürze um ${over} Zeichen — oder schick es in zwei Nachrichten.`,
    en: `A little long for chat — trim ${over}, or send it as two messages.`,
  };
}

/**
 * The gentle nudge shown while the visitor still has room. Says what is left,
 * not what is used: "40 left" is a budget, "260 / 300" is a measurement.
 */
export function nearLimitMessage(text: string): string {
  const { de, en } = nearLimitParts(text);
  return `${de} · ${en}`;
}

/** {@link nearLimitMessage}, split by language. */
export function nearLimitParts(text: string): { de: string; en: string } {
  const left = messageCharsLeft(text);
  return { de: `Noch ${left} Zeichen`, en: `${left} characters left` };
}

/** Short, static form for API responses (no visitor text echoed back). */
export const TOO_LONG_API_DETAIL = `Message too long. Maximum ${MAX_MESSAGE_CHARS} characters.`;

/**
 * Pull the chat message out of an eve request body, for the server-side check.
 *
 * eve's session-create and follow-up routes both carry `{ message: "..." }`.
 * Anything else (a body without a message, a non-object, an unexpected shape)
 * returns `null` and is left alone: this guard exists to reject over-long text,
 * never to become a second, half-informed schema validator for eve's protocol.
 */
export function extractMessageText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
