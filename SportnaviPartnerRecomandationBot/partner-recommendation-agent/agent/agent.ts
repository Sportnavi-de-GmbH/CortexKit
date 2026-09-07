// Load .env.local into the dev-host process — `eve dev` does not do this
// itself, and without it the session.started model resolver below throws
// (missing Azure vars) and eve silently falls back to the AI Gateway model.
import "../lib/load-env";

import { defineAgent } from "eve";
import { getAzureChatModel } from "../lib/llm";

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
  // eve resolves compaction metadata for the `fallback` model at compile
  // time via the AI Gateway catalog, offline, before any session runs — so
  // this override skips that lookup with a hardcoded context window. The
  // Azure deployment (the model actually used) is resolved lazily above, at
  // session start, so this MUST track that deployment, not the fallback:
  // gpt-4o-mini's window is 128k, not gpt-4.1's ~1M. Leaving the 1M value
  // here would tell eve's compaction there is 8x more room than exists.
  modelContextWindowTokens: 128_000,
  model: resolveModel(),
  // Explicit session-wide token ceiling (production-readiness review item
  // 6): eve's own default (`maxInputTokensPerSession`) is unset, which
  // silently falls back to the platform default of 40,000,000 tokens per
  // session — not a meaningful ceiling for this product. This is a
  // multi-turn CONVERSATION budget, not a per-request one; the per-request
  // budget lives in lib/request-budget.ts and is enforced inside the tools
  // (agent/tools/find_partners.ts, agent/tools/get_partner_details.ts).
  // 3M input tokens covers roughly 70 searches at the current wide-context
  // config's measured ~42k tokens/search (see CLAUDE.md §7) — generous for
  // one conversation. Tightening further is a product decision tied to the
  // still-open config-profile question in the prior production-readiness
  // review, not addressed here.
  limits: {
    maxInputTokensPerSession: 500_000,
    maxOutputTokensPerSession: 300_000,
  },
});
