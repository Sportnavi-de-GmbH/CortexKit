/**
 * lib/llm-port.ts — the three model calls the workflow makes, behind one
 * interface so tests use a fake and the pipeline never imports the AI SDK.
 * The Azure implementation is `createAzureLlmPort()` (added with the runner).
 */
export interface LlmPort {
  readonly modelName: string;
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

export function createAzureLlmPort(): LlmPort {
  const model = getAzureChatModel();
  const modelName = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "azure";
  return {
    modelName,
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
