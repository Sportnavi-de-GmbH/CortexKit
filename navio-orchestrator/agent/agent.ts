// Load .env.local into the dev-host process — `eve dev` does not do this itself.
// Must be imported FIRST (see lib/load-env.ts).
import "../lib/load-env.ts";

import { defineAgent } from "eve";
import { getAzureRouterModel, routerContextWindowTokens } from "../lib/llm.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MASTER AGENT (router / orchestrator)
//
// This is the ONLY agent the user talks to. It owns intent detection and
// delegation; it owns almost no knowledge of its own. See
// ../../docs/NAVIO-MULTI-AGENT-ARCHITECTURE.md §3.
//
// Its capabilities, and how each is reached:
//   agent/subagents/faq/        LOCAL subagent  → lowered to the tool `faq`
//   agent/tools/find_partners   HTTP tool       → partner agent deployment
//   agent/tools/request_human_contact           → approval-gated escalation
//
// The router and the FAQ subagent both run gpt-4o (AZURE_ROUTER_DEPLOYMENT_NAME /
// AZURE_AI_CHATBOT_DEPLOYMENT_NAME, upgraded from gpt-4o-mini 2026-09-08 after a
// live transcript reproduced §2.4c's 40%-accuracy failure modes). The routing
// turn runs on EVERY message but only has to pick a route and relay; answer
// quality lives in the FAQ subagent.
//
// KEEP agent/instructions.md SMALL (≤2k tokens). It replays on every turn. The
// 16.7k-token knowledge base belongs to the FAQ subagent and must never leak up
// here — that would defeat the entire point of a mini router.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Router model. Same degradation contract as service 1: this module must stay
 * importable with an empty environment (CI has no secrets), so a missing-env
 * throw degrades to a gateway model id that fails loudly at call time.
 */
function resolveRouterModel() {
  const gatewayModel = process.env.AI_GATEWAY_ROUTER_MODEL?.trim() ?? process.env.AI_GATEWAY_MODEL?.trim();
  if (gatewayModel) return gatewayModel;
  try {
    return getAzureRouterModel();
  } catch {
    return "openai/gpt-4o";
  }
}

/** Env-tunable session budget; `0` ⇒ explicitly uncapped (eve's `false`). */
function limitFromEnv(name: string, fallback: number): number | false {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? false : n;
}

export default defineAgent({
  description:
    "Navio — Sportnavi's public assistant. Understands what the visitor needs and " +
    "routes it to the right specialist: FAQ knowledge, partner/studio search, or a " +
    "human hand-off.",
  // Must match the ROUTER deployment, not the FAQ one. eve resolves compaction
  // metadata from this at compile time, so a wrong number makes compaction fire
  // at the wrong point. gpt-4o-mini is 128k.
  modelContextWindowTokens: routerContextWindowTokens(),
  model: resolveRouterModel(),
  limits: {
    // Higher input budget than service 1: one visitor turn can now cost a router
    // call PLUS a 16.7k-token FAQ subagent call. The subagent runs in its own
    // child session with its own budget, so this cap covers the router only.
    maxInputTokensPerSession: limitFromEnv("NAVIO_MAX_INPUT_TOKENS_PER_SESSION", 250_000),
    maxOutputTokensPerSession: limitFromEnv("NAVIO_MAX_OUTPUT_TOKENS_PER_SESSION", 20_000),
  },
});
