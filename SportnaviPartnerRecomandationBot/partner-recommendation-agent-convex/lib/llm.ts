import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Constructs the Azure-backed chat model from
 * `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` / `AZURE_AI_CHATBOT_API_KEY` /
 * `AZURE_AI_CHATBOT_DEPLOYMENT_NAME`.
 *
 * Throws a clear error naming the missing env var(s) if endpoint or api key
 * is unset. Call this lazily (e.g. from a `defineDynamic` model resolver in
 * `agent/agent.ts`) rather than at module load time — `agent.ts` must stay
 * importable with an empty environment.
 */
export function getAzureChatModel(): LanguageModel {
  const baseURL = process.env.AZURE_AI_CHATBOT_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_AI_CHATBOT_API_KEY;

  const missing: string[] = [];
  if (!baseURL) missing.push("AZURE_AI_CHATBOT_OPENAI_ENDPOINT");
  if (!apiKey) missing.push("AZURE_AI_CHATBOT_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `getAzureChatModel: missing required environment variable(s): ${missing.join(", ")}`,
    );
  }

  const azure = createOpenAI({ baseURL, apiKey });
  return azure.chat(process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "gpt-4o-mini");
}
