// Reply-language hint for the FAQ agent (language fidelity, prompt sections 2.1 / 6A / 9 / 11).
//
// WHY THIS EXISTS. The system prompt already says "answer in the language of the last user
// message" in four places, and gpt-4.1 still drifted to German on English turns — measured on
// production 2026-09-17: 3 of 8 probe turns ("Tell me about the prices", "Why should I use
// Sportnavi?", and an English follow-up) came back in German, while French and Spanish were
// fine. The prompt is ~22k tokens of German; a rule buried in it loses to that mass. A short
// note placed RIGHT NEXT to the visitor's message (recency) is what the model actually obeys.
//
// HOW IT IS USED. `agent/channels/eve.ts` calls `replyLanguageHint()` from the eve channel's
// `onMessage` hook and returns it as `context`, which eve prepends to the turn as a user-role
// message immediately before the visitor's text. Nothing is interpolated into the system
// prompt, so the Azure prompt-cache prefix stays byte-identical (CLAUDE.md §9).
//
// DETECTION IS DELIBERATELY CONSERVATIVE. Only German vs English are decided, by stop-word
// counts, and only when one side clearly wins. Anything else (French, Spanish, a lone city
// name, an emoji) gets a neutral reminder rather than a wrong verdict — the model's own
// detection is good for those; it is the German default on English input that needed fixing.

const DE_WORDS = new Set([
  "und", "oder", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "ich", "du", "wir", "ihr", "sie", "es", "mich", "mir", "dich", "dir", "uns", "euch", "sich",
  "mein", "meine", "meinen", "meinem", "dein", "deine", "deinen", "deinem", "unser", "unsere",
  "ist", "sind", "bin", "bist", "war", "wird", "werden", "kann", "kannst", "können", "muss",
  "müssen", "soll", "sollte", "möchte", "will", "habe", "hat", "haben", "gibt", "geht",
  "nicht", "kein", "keine", "auch", "noch", "nur", "schon", "sehr", "hier", "dort", "jetzt",
  "wie", "was", "wo", "wann", "warum", "wieso", "welche", "welcher", "welches", "wer",
  "für", "mit", "bei", "auf", "zu", "zum", "zur", "im", "in", "am", "an", "von", "vom", "aus",
  "nach", "über", "unter", "ohne", "um", "bis", "seit", "wenn", "dass", "weil", "aber", "denn",
  "als", "ob", "bitte", "danke", "hallo", "kosten", "kostet", "preis", "preise",
  "funktioniert", "nutzen", "mitgliedschaft", "kündigen", "einchecken", "check-in",
]);

const EN_WORDS = new Set([
  "the", "and", "or", "a", "an", "of", "to", "in", "on", "at", "for", "with", "from", "by",
  "about", "into", "as", "is", "are", "am", "was", "were", "be", "been", "do", "does", "did",
  "can", "could", "should", "would", "will", "may", "might", "must", "have", "has", "had",
  "i", "you", "we", "they", "he", "she", "it", "me", "my", "your", "our", "their", "its",
  "this", "that", "these", "those", "there", "here", "not", "no", "yes", "also", "only",
  "how", "what", "where", "when", "why", "which", "who", "if", "because", "but", "so",
  "please", "thanks", "thank", "hello", "hi", "tell", "explain", "use", "using", "need",
  "want", "get", "cost", "costs", "price", "prices", "membership", "cancel", "work", "works",
]);

export type ReplyLanguage = "de" | "en" | "unknown";

/** Words of a message: letters (incl. umlauts/ß), digits, hyphens; lower-cased. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Decide the visitor's language when it is clearly German or clearly English; otherwise
 * `unknown`. Umlauts/ß count as German evidence. Ties and empty evidence are `unknown`.
 */
export function detectReplyLanguage(text: string): ReplyLanguage {
  const words = tokens(text);
  if (words.length === 0) return "unknown";
  let de = /[äöüß]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const w of words) {
    if (DE_WORDS.has(w)) de += 1;
    if (EN_WORDS.has(w)) en += 1;
  }
  if (de === 0 && en === 0) return "unknown";
  if (de > en) return "de";
  if (en > de) return "en";
  return "unknown";
}

/**
 * Pull the plain text out of what the eve channel hands `onMessage`: a string, or a
 * UserContent array whose text parts are `{ type: "text", text }`.
 */
export function messageTextOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message
      .map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The note eve prepends to the turn. Written in the target language on purpose: an English
 * note is itself a nudge toward English (measured: German-only rule text pulled gpt-4.1 into
 * German, CLAUDE.md §5.1). The `[[action:…]]` markers are excluded explicitly because
 * section 7 of the prompt requires them verbatim in every language.
 */
export function replyLanguageHint(message: unknown): string {
  const text = messageTextOf(message);
  const lang = detectReplyLanguage(text);
  if (lang === "en") {
    return (
      "[Widget note — not written by the visitor] The visitor's next message is in ENGLISH. " +
      "Write your entire reply in English: every sentence, heading, the notice about details " +
      "possibly having changed, and the closing line. Do not switch to German. " +
      "Keep the [[action:...]] markers exactly as they are."
    );
  }
  if (lang === "de") {
    return (
      "[Widget-Hinweis — nicht vom Besucher] Die nächste Nachricht des Besuchers ist auf DEUTSCH. " +
      "Antworte vollständig auf Deutsch. Die [[action:...]]-Marker bleiben unverändert."
    );
  }
  return (
    "[Widget note — not written by the visitor] Reply entirely in the same language as the " +
    "visitor's next message (German → German, English → English, any other language → that " +
    "language). Never fall back to German for a non-German message. " +
    "Keep the [[action:...]] markers exactly as they are."
  );
}
