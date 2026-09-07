// Load .env.local into the dev-host process — `eve dev` does not do this
// itself, and without it the session.started model resolver below throws
// (missing Azure vars) and eve silently falls back to the AI Gateway model.
import "../lib/load-env";

import { defineAgent } from "eve";
import { getAzureChatModel } from "../lib/llm";
import { getModelContextWindowTokens } from "../lib/model-limits";

// The Azure model is resolved statically at module load — .env.local was
// loaded by the import above. agent.ts must stay importable with an empty
// environment (the smoke test imports it directly; CI has no secrets), so a
// missing-env throw degrades to the gateway model id, which fails loudly at
// call time with a clear credentials message.
function resolveModel() {
  try {
    return getAzureChatModel();
  } catch {
    return "openai/gpt-4o-mini";
  }
}

export default defineAgent({
  description:
    "Partner Finder: assembles a relevant, appropriately-sized set of " +
    "partners for a city-based request and returns clear recommendations.",
  // eve resolves compaction metadata for the `fallback` model at compile time
  // via the AI Gateway catalog, offline, before any session runs — so this
  // override skips that lookup. The Azure deployment (the model actually used)
  // is resolved lazily above, at session start.
  //
  // DERIVED, never hardcoded. This number is what eve's compaction uses to
  // decide when to summarize instead of sending the whole conversation, so it
  // has to track AZURE_AI_CHATBOT_DEPLOYMENT_NAME. It was pinned to gpt-4.1's
  // 1,047,576 for a long time; when the deployment moved to gpt-4o-mini
  // (128,000) that was wrong by 8x, eve never compacted, and Azure rejected
  // requests with `context_length_exceeded` at ~141k tokens. See
  // lib/model-limits.ts.
  modelContextWindowTokens: getModelContextWindowTokens(),
  model: resolveModel(),
  // Explicit session-wide token ceiling (production-readiness review item
  // 6): eve's own default (`maxInputTokensPerSession`) is unset, which
  // silently falls back to the platform default of 40,000,000 tokens per
  // session — not a meaningful ceiling for this product. This is a
  // multi-turn CONVERSATION budget, not a per-request one; the per-request
  // budget lives in lib/request-budget.ts and is enforced inside the tools
  // (agent/tools/find_partners.ts, agent/tools/get_partner_details.ts).
  // 500k input tokens covers ~90 typical relevance-sized searches (~5.4k
  // tokens each under the R13 defaults) — generous for one conversation.
  limits: {
    maxInputTokensPerSession: 500_000,
    maxOutputTokensPerSession: 300_000,
  },
});
