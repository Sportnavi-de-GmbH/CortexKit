import { getAzureChatModel } from "../../../lib/llm.ts";
import { defineAgent } from "eve";

// ─────────────────────────────────────────────────────────────────────────────
// FAQ SUBAGENT — the knowledge specialist.
//
// eve lowers this directory to a model-visible tool named `faq` with the shape
// { message, outputSchema? }. The `description` below is what the master reads
// when it decides whether to delegate — it IS the routing contract, so the
// negative clause ("NICHT für …") matters as much as the positive one. Most
// routing regressions trace back to a vague description, not to the router model.
//
// ⚠ THE ISOLATION BOUNDARY (eve 0.25.3 docs/subagents.mdx)
// A declared subagent inherits NOTHING from the root. An absent slot falls back
// to the FRAMEWORK DEFAULT, not to the root's version. That is why this
// directory carries its own full set of 11 `disableTool()` sentinels in
// ./tools/ — without them this agent silently regains `web_search` and stops
// being tool-free, which is the one property the FAQ agent must have (a search
// tool would give it a source of truth outside the curated knowledge base).
//
// Its knowledge is `instructions.md` — a verbatim copy of service 1's ~16.7k
// token prompt. It is COPIED, not shared, so this project can trial Prompt V3
// while service 1 keeps running the current one.
// ─────────────────────────────────────────────────────────────────────────────

function resolveModel() {
  const gatewayModel = process.env.AI_GATEWAY_MODEL?.trim();
  if (gatewayModel) return gatewayModel;
  try {
    return getAzureChatModel(process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "gpt-4o-mini");
  } catch {
    return "openai/gpt-4o-mini";
  }
}

export default defineAgent({
  // Read by the master when routing. Keep both halves.
  description:
    "Beantwortet Fragen zu Sportnavi selbst aus der offiziellen Wissensdatenbank: " +
    "Tarife, Preise, Verträge, Kündigung, Check-in, Cashback, Mitgliedschaft, " +
    "Firmenfitness, Arbeitgeber-Angebote, Partner-werden, Abrechnung, App-Nutzung. " +
    "NICHT für die Suche nach konkreten Studios, Kursen oder Orten zum Trainieren — " +
    "dafür ist find_partners zuständig.",
  // Must track the Azure deployment resolved above — gpt-4o-mini is 128k.
  modelContextWindowTokens: 128_000,
  model: resolveModel(),
});
