/**
 * lib/llm-port.ts — the three model calls the workflow makes, behind one
 * interface so tests use a fake and the pipeline never imports the AI SDK.
 * The Azure implementation is `createAzureLlmPort()` (added with the runner).
 */
import type { Task } from "../workflow/types";

/** What the decomposition model returns per task; ids are assigned by stage 0, not the model. */
export interface RawTask {
  label: string;
  query: string;
  cityMention: string | null;
  priority: number;
  /** id of a pending task this message answers (merge into it), else null. */
  resolvesPending: string | null;
}

export interface LlmPort {
  readonly modelName: string;
  /** Stage 0: independent search tasks in the message; may merge a pending task. */
  decompose(query: string, opts: { pending: Task[]; signal: AbortSignal }): Promise<{ tasks: RawTask[] }>;
  /** Stage 1: the location verbatim as the user wrote it, or null. */
  detectCity(query: string, opts: { signal: AbortSignal }): Promise<{ cityMention: string | null }>;
  /** Stage 2: a descriptive German semantic-search query preserving the intent. */
  reformulate(query: string, opts: { maxChars: number; signal: AbortSignal }): Promise<string>;
  /** Stage 6: the user-facing answer from a fully rendered prompt. */
  answer(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
}

import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getAzureChatModel } from "./reused/llm";

const citySchema = z.object({
  cityMention: z.string().nullable().describe("The city/town/place the user wants to train in, VERBATIM as written (may be misspelled). null if no location is mentioned."),
});

const rawTaskSchema = z.object({
  label: z.string().describe("Short heading for this search, at most 40 characters, e.g. 'Tennis in Dortmund'."),
  query: z.string().describe("Self-contained German sub-query in the user's own words, including the place if the user named one for it."),
  cityMention: z.string().nullable().describe("The place VERBATIM as written for this task (may be misspelled), or null. Never guess. 'in meiner Nähe' / 'hier' are NOT a city."),
  priority: z.number().int().describe("1 = run first. Tasks with both a place and an activity before tasks missing one; otherwise order of mention."),
  resolvesPending: z.string().nullable().describe("id of the pending task this message answers (usually by naming its city), else null."),
});
const decomposeSchema = z.object({ tasks: z.array(rawTaskSchema) });

const DECOMPOSE_SYSTEM = [
  "You split one user message into independent partner-search tasks for a German sports, health and therapy directory.",
  "Rules:",
  "- One task per genuinely independent search intent. Two intents are independent when they differ in the activity/health need OR in the place. Closely related activities the user wants in one list (e.g. 'Yoga oder Pilates in Bochum') stay ONE task.",
  "- query: a self-contained German sub-query in the user's own words; include the place if the user named one for that intent.",
  "- label: at most 40 characters.",
  "- cityMention: the place VERBATIM as written, or null. Never invent or guess a city.",
  "- priority: 1 = run first. Tasks that have both a place and an activity come before tasks missing one; otherwise keep the order of mention.",
  "- If pending tasks are given and the message answers one of their open questions (usually by naming a city), set resolvesPending to that task's id and put the completed request into query/cityMention. Otherwise resolvesPending is null.",
  "- A message that is not a search still yields exactly one task with the whole message as query.",
  "- Never return zero tasks.",
].join("\n");

export function createAzureLlmPort(): LlmPort {
  const model = getAzureChatModel();
  const modelName = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "azure";
  return {
    modelName,
    async decompose(query, { pending, signal }) {
      const pendingText = pending.length
        ? `\n\nPending tasks from the previous turn (id · label · query):\n${pending.map((p) => `- ${p.id} · ${p.label} · ${p.query}`).join("\n")}`
        : "";
      const { object } = await generateObject({
        model, schema: decomposeSchema, abortSignal: signal, temperature: 0,
        system: DECOMPOSE_SYSTEM,
        prompt: `User message:\n${query}${pendingText}`,
      });
      return { tasks: object.tasks };
    },
    async detectCity(query, { signal }) {
      const { object } = await generateObject({
        model, schema: citySchema, abortSignal: signal, temperature: 0,
        system: "Extract only the location the user wants to train in. Do not guess a city that is not in the text. Words like 'in meiner Nähe' or 'hier' are NOT a city.",
        prompt: query,
      });
      return { cityMention: object.cityMention?.trim() || null };
    },
    async reformulate(query, { maxChars, signal }) {
      const { text } = await generateText({
        model, abortSignal: signal, temperature: 0.2,
        system: [
          "Du formulierst Nutzerfragen in eine ausführlichere, semantisch reichhaltige Suchanfrage für eine Vektorsuche über Sport-, Gesundheits- und Therapieangebote um.",
          "Behalte die Absicht des Nutzers exakt bei: die gesuchte Sportart/Leistung, das gesundheitliche Anliegen, Vorlieben und Einschränkungen und den Ort.",
          "Ergänze passende Synonyme und typische Angebotsbezeichnungen (z. B. Reha-Sport, Physiotherapie, Kurse, Training), aber erfinde keine Fakten.",
          `Antworte NUR mit der Suchanfrage: ein Absatz, Deutsch, maximal ${maxChars} Zeichen, keine Anrede, keine Erklärung, keine Anführungszeichen.`,
        ].join(" "),
        prompt: query,
      });
      return text.trim();
    },
    async answer(prompt, { signal }) {
      const { text } = await generateText({ model, abortSignal: signal, temperature: 0.3, prompt });
      return text;
    },
  };
}
