import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Azure model resolution for the multi-agent Navio.
 *
 * This project runs TWO models, and — unlike service 1 — they may live on
 * DIFFERENT Azure resources, each with its own endpoint and key:
 *
 *   ROUTER   the master agent. Runs on EVERY message but only picks a route and
 *            relays the specialist's answer, so it is small and cheap.
 *            AZURE_ROUTER_* (falls back to the chatbot resource when unset).
 *   FAQ      the knowledge subagent, answering from the ~16.7k-token prompt.
 *            AZURE_AI_CHATBOT_*.
 *
 * Endpoints must use Azure's `/openai/v1` surface, e.g.
 *   https://<resource>.openai.azure.com/openai/v1
 * The classic `/openai/deployments/<name>` form 404s here, because the SDK
 * appends the deployment itself — verified against both resources.
 *
 * Both getters throw a clear, named error when their env is missing. Call them
 * lazily: `agent.ts` must stay importable with an empty environment (CI has no
 * secrets), where the throw degrades to a gateway model id that fails loudly at
 * call time instead of at import time.
 */

function build(baseURL: string, apiKey: string, deployment: string): LanguageModel {
  return createOpenAI({ baseURL, apiKey }).chat(deployment);
}

/** Throw naming every missing variable at once, so one run fixes the whole set. */
function requireAll(caller: string, vars: Record<string, string | undefined>): void {
  const missing = Object.entries(vars)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${caller}: missing required environment variable(s): ${missing.join(", ")}`);
  }
}

/** The answering model — the FAQ subagent (and anything else that needs quality). */
export function getAzureChatModel(deployment?: string): LanguageModel {
  const baseURL = process.env.AZURE_AI_CHATBOT_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_AI_CHATBOT_API_KEY;

  requireAll("getAzureChatModel", {
    AZURE_AI_CHATBOT_OPENAI_ENDPOINT: baseURL,
    AZURE_AI_CHATBOT_API_KEY: apiKey,
  });

  return build(
    baseURL!,
    apiKey!,
    deployment ?? process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "gpt-4o",
  );
}

/**
 * The routing model. Uses AZURE_ROUTER_OPENAI_ENDPOINT / AZURE_ROUTER_API_KEY
 * when set — the router deployment can live on a different Azure resource than
 * the FAQ model — and otherwise falls back to the chatbot resource so a
 * single-resource setup needs only AZURE_ROUTER_DEPLOYMENT_NAME.
 */
export function getAzureRouterModel(): LanguageModel {
  const baseURL =
    process.env.AZURE_ROUTER_OPENAI_ENDPOINT?.trim() ||
    process.env.AZURE_AI_CHATBOT_OPENAI_ENDPOINT;
  const apiKey =
    process.env.AZURE_ROUTER_API_KEY?.trim() || process.env.AZURE_AI_CHATBOT_API_KEY;

  requireAll("getAzureRouterModel", {
    "AZURE_ROUTER_OPENAI_ENDPOINT (or AZURE_AI_CHATBOT_OPENAI_ENDPOINT)": baseURL,
    "AZURE_ROUTER_API_KEY (or AZURE_AI_CHATBOT_API_KEY)": apiKey,
  });

  return build(baseURL!, apiKey!, process.env.AZURE_ROUTER_DEPLOYMENT_NAME ?? "gpt-4o");
}

/**
 * Context window for the router deployment. eve resolves compaction metadata at
 * compile time, so a wrong number here means compaction fires at the wrong point.
 * The configured deployment is gpt-4o: a 128k window. Override with
 * AZURE_ROUTER_CONTEXT_WINDOW only if the deployment ever changes.
 */
export function routerContextWindowTokens(): number {
  const explicit = Number(process.env.AZURE_ROUTER_CONTEXT_WINDOW);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return 128_000;
}
