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

// Per-session execution budgets (production-readiness review §P2.6). Navio is a
// PUBLIC, ANONYMOUS endpoint, so an uncapped session is a direct cost/abuse risk:
// eve's default is 40M input tokens/session (~$80 at gpt-4.1 list) with output
// UNCAPPED. A support session is a handful of short turns, so we cap both far
// lower. eve checks the input cap before each model call and blocks further
// calls in the session once it is crossed (the crossing call is allowed to
// finish, since providers only report exact usage after completion).
//
// Both are env-tunable without a code change; set the env to `0` to disable a
// cap (mapped to eve's `false`). Keep these SMALL — the real hard cost ceiling
// for a public endpoint is the AI Gateway spend cap (see resolveModel + §P2.6).
function limitFromEnv(name: string, fallback: number): number | false {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? false : n; // 0 ⇒ explicitly uncapped
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
  limits: {
    // ~250k input tokens ≈ 15 turns of the full ~16.7k prompt — generous for a
    // real support chat, but bounds a runaway/abusive session to ~$0.50.
    maxInputTokensPerSession: limitFromEnv("NAVIO_MAX_INPUT_TOKENS_PER_SESSION", 250_000),
    // Hard ceiling on generated tokens per session (default is uncapped).
    maxOutputTokensPerSession: limitFromEnv("NAVIO_MAX_OUTPUT_TOKENS_PER_SESSION", 20_000),
  },
});
