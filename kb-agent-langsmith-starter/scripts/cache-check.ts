// Prompt-caching diagnostic for the Azure OpenAI deployment.
//
//   npm run cache:check
//
// Azure OpenAI prompt caching is AUTOMATIC (no flag) for supported models
// (gpt-4o-mini) with api-version >= 2024-10-01, when the prompt prefix is >= 1024
// tokens and identical across requests. This makes two back-to-back calls that
// share the FULL system prompt (the stable prefix) and differ only in the user
// question, then prints the cached-token count so we can SEE whether caching is
// working on this deployment.
//
// Expected if caching works: call #2's cachedInputTokens ≈ the system-prompt
// size (~16.7k). If it stays 0, caching isn't triggering — see the notes below.
//
// ⚠️ This makes 2 real Azure calls (~$0.07 total).

import "../lib/load-env"; // MUST be first — loads .env.local before we read env
import { readFileSync } from "node:fs";
import { generateText } from "ai";
import { getAzureChatModel } from "../lib/llm.ts";

const systemPrompt = readFileSync("agent/instructions.md", "utf8");

async function call(userMessage: string) {
  return generateText({
    model: getAzureChatModel(),
    system: systemPrompt,
    prompt: userMessage,
    maxOutputTokens: 60,
  });
}

function cachedTokens(res: Awaited<ReturnType<typeof call>>): number {
  const u = res.usage as Record<string, unknown>;
  const inDetails = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  const meta = (res.providerMetadata?.openai ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // AI SDK v7 (Azure/OpenAI): cache hits live in usage.inputTokenDetails.cacheReadTokens.
  return (
    n(inDetails.cacheReadTokens) ||
    n(u.cachedInputTokens) ||
    n(meta.cachedPromptTokens) ||
    n(meta.cached_tokens)
  );
}

function report(label: string, res: Awaited<ReturnType<typeof call>>) {
  const cached = cachedTokens(res);
  console.log(`\n--- ${label} ---`);
  console.log("usage:", JSON.stringify(res.usage));
  console.log("providerMetadata.openai:", JSON.stringify(res.providerMetadata?.openai ?? null));
  console.log(`cached input tokens: ${cached}`);
  return cached;
}

async function main() {
  const approxTokens = Math.round(systemPrompt.length / 4);
  console.log(`System prompt (stable prefix): ${systemPrompt.length} chars ≈ ${approxTokens} tokens`);
  console.log(`Deployment: ${process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "gpt-4o-mini"}`);
  console.log("Making 2 back-to-back calls sharing the same system prompt…");

  const r1 = await call("Was ist Firmenfitness? Antworte in einem Satz.");
  const c1 = report("Call 1 (cold — expect 0 cached)", r1);
  const r2 = await call("Wie kündige ich meine Mitgliedschaft? Antworte in einem Satz.");
  const c2 = report("Call 2 (warm — expect cached ≈ prompt size if supported)", r2);

  console.log("\n=================== VERDICT ===================");
  if (c2 > 1000) {
    console.log(`✅ Prompt caching IS working — call #2 reused ${c2} cached tokens.`);
    console.log(`   That prefix is billed ~75% cheaper. Savings are already happening;`);
    console.log(`   we just need to surface app.tokens.cached in the traces.`);
  } else if (c1 > 1000) {
    console.log("✅ Caching working (even call #1 hit a warm cache from earlier traffic).");
  } else {
    console.log("❌ No cached tokens reported. Either:");
    console.log("   • the Azure api-version is < 2024-10-01 (bump it in AZURE_AI_CHATBOT_OPENAI_ENDPOINT), or");
    console.log("   • this deployment/region doesn't support prompt caching, or");
    console.log("   • the AI SDK isn't surfacing cached_tokens for this provider config.");
    console.log("   → Fall back to routing via the Vercel AI Gateway (explicit cache + metrics),");
    console.log("     or add a response cache for repeat questions.");
  }
}

main().catch((e) => {
  console.error("cache-check failed:", e);
  process.exit(1);
});
