// Load .env.local into the dev-host process — `eve dev` does not do this
// itself, and without it the model resolver below throws (missing Azure vars)
// and eve silently falls back to the AI Gateway model.
import "../lib/load-env.ts";

import { defineAgent } from "eve";
import { getAzureChatModel } from "../lib/llm.ts";

// agent.ts must stay importable with an empty environment (the smoke test
// imports it directly; CI has no secrets), so a missing-env throw degrades to
// the gateway model id, which fails loudly at call time with a clear
// credentials message.
//
// Model routing (see MVP plan §8, "Layer 5"): when `AI_GATEWAY_MODEL` is set,
// calls route through the Vercel AI Gateway. This is what activates the hard
// spend cap and per-visitor cost attribution — the real cost ceiling for a
// public, anonymous endpoint. Keep Azure OpenAI (EU) as the provider *behind*
// the gateway via BYOK (configured in the Gateway dashboard) so the EU data
// path is preserved. With the env unset, the agent calls the Azure deployment
// directly, exactly as before.
function resolveModel() {
  const gatewayModel = process.env.AI_GATEWAY_MODEL?.trim();
  if (gatewayModel) return gatewayModel;
  try {
    return getAzureChatModel();
  } catch {
    return "openai/gpt-4.1";
  }
}

// This agent has no tools, no subagents, and no skills by design: its entire
// behaviour comes from the system prompt in `agent/instructions.md`.
//
// "No tools" takes work: eve's harness ships built-ins (bash, web_search,
// read_file, …) unless each is disabled. `agent/tools/` holds one
// `disableTool()` sentinel per built-in for exactly that reason.
export default defineAgent({
  description:
    "Knowledge Base & FAQ agent: answers questions using only the knowledge " +
    "base injected into its system prompt.",
  // eve resolves compaction metadata for the fallback model at compile time
  // via the AI Gateway catalog; this override skips that lookup with
  // gpt-4.1's known context window. The Azure deployment (the model actually
  // used) is resolved above.
  modelContextWindowTokens: 1_047_576,
  model: resolveModel(),
});
