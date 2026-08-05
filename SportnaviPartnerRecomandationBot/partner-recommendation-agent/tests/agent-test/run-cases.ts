/**
 * run-cases.ts — executes dataset.json test cases against the REAL agent
 * stack: real Azure OpenAI model, real Supabase data, real instructions.md
 * (main + partner-curator) as system prompts, real lib/partners/* pipeline
 * functions as callable tools. The model itself decides which tools to call
 * and when — this is NOT a hardcoded pipeline simulation, so it genuinely
 * tests the agent's own judgment (e.g. whether it skips the search for an
 * uncovered city, or re-searches unnecessarily on a follow-up).
 *
 * Honest scope note: this drives the same instructions/tools/model as
 * production, via the `ai` SDK's own tool-calling loop, NOT the Eve
 * framework's runtime (`eve dev`). The partner-curator "subagent" is modeled
 * as a callable tool that internally makes its own generateObject call with
 * partner-curator/instructions.md as its system prompt — the same instructions
 * file the real subagent uses, just invoked directly rather than through Eve's
 * subagent dispatch.
 *
 * Run:
 *   npx tsx tests/agent-test/run-cases.ts --pilot        (the 5 pilot cases)
 *   npx tsx tests/agent-test/run-cases.ts --ids=4,6,11   (specific cases)
 *   npx tsx tests/agent-test/run-cases.ts                (all 30 — real cost, real time)
 *
 * Rate-limit handling: fully sequential (no concurrency), a courtesy delay
 * between cases, and exponential-backoff retry on 429s. This is deliberately
 * conservative — Azure OpenAI deployments commonly have low tokens-per-minute
 * quotas on non-production tiers, and 30 cases × ~4 model calls each adds up.
 */
import "../../lib/load-env";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, generateObject, stepCountIs } from "ai";
import { z } from "zod";
import { getAzureChatModel } from "../../lib/llm";
import { extractCityAndIntent } from "../../lib/partners/extract-city";
import { resolvePartners } from "../../lib/partners/resolve-partners";
import { buildRecommendations } from "../../lib/partners/build-recommendations";
import { getPartnerDetails } from "../../lib/partners/get-partner-details";
import { renderTier1, renderTier2 } from "../../lib/partners/render-context";
import type { ResolvedPartnerSet, Intent } from "../../lib/partners/types";
import dataset from "./dataset.json";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, "..", "..", "agent");
const INSTRUCTIONS = fs.readFileSync(path.join(AGENT_DIR, "instructions.md"), "utf8");
const COVERAGE = fs.readFileSync(
  path.join(AGENT_DIR, "instructions", "002-city-coverage.md"),
  "utf8",
);
const CURATOR_INSTRUCTIONS = fs.readFileSync(
  path.join(AGENT_DIR, "subagents", "partner-curator", "instructions.md"),
  "utf8",
);
const SYSTEM_PROMPT = `${INSTRUCTIONS}\n\n---\n\n${COVERAGE}`;

const CASE_DELAY_MS = 3000; // courtesy pause between cases
const TURN_DELAY_MS = 1200; // courtesy pause between turns/calls
const MAX_RETRY_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = /429|rate.?limit|too many requests/i.test(msg);
      if (attempt >= MAX_RETRY_ATTEMPTS || !isRateLimit) throw err;
      const backoff = 2000 * 2 ** (attempt - 1);
      console.warn(
        `  [retry] ${label} hit a rate limit (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}) — waiting ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
}

async function runCurator(
  intent: Intent,
  shortlist: unknown[],
): Promise<{ ranked: Array<{ id: number; reason: string }> }> {
  const schema = z.object({
    ranked: z.array(
      z.object({
        id: z.number(),
        reason: z.string(),
      }),
    ),
  });
  const { object } = await generateObject({
    model: getAzureChatModel(),
    schema,
    system: CURATOR_INSTRUCTIONS,
    prompt: `intent: ${JSON.stringify(intent)}\nshortlist: ${JSON.stringify(shortlist)}`,
  });
  return object;
}

/** Builds a fresh tool set per case run — `lastSet` closure carries the
 * resolved partner set from resolve_partners to build_recommendations,
 * mirroring how the real Eve session holds state across tool calls within
 * one turn. */
function makeTools() {
  let lastSet: ResolvedPartnerSet | null = null;

  return {
    extract_city_and_intent: {
      description:
        "Extract the city and search intent from the user's request. Call this first for any new search.",
      inputSchema: z.object({ requestText: z.string() }),
      execute: async ({ requestText }: { requestText: string }) =>
        withRetry(() => extractCityAndIntent({ requestText }), "extract_city_and_intent"),
    },
    resolve_partners: {
      description:
        "Resolve the working set of partners for a confirmed, covered city + intent. Only call " +
        "this after extract_city_and_intent returned a city that IS in the coverage list above. " +
        "Never call this for a city that is not in the coverage list.",
      inputSchema: z.object({
        cityCanonical: z.string(),
        cityInput: z.string(),
        cityConfidence: z.number(),
        cityPartnerCount: z.number(),
        centroidLat: z.number().nullable(),
        centroidLng: z.number().nullable(),
        intentText: z.string(),
        intentTags: z.array(z.string()),
      }),
      execute: async (args: {
        cityCanonical: string;
        cityInput: string;
        cityConfidence: number;
        cityPartnerCount: number;
        centroidLat: number | null;
        centroidLng: number | null;
        intentText: string;
        intentTags: string[];
      }) => {
        const city = {
          input: args.cityInput,
          canonical: args.cityCanonical,
          aliases: [args.cityCanonical],
          centroid:
            args.centroidLat != null && args.centroidLng != null
              ? { lat: args.centroidLat, lng: args.centroidLng }
              : null,
          partnerCount: args.cityPartnerCount,
          confidence: args.cityConfidence,
        };
        const intent: Intent = { text: args.intentText, tags: args.intentTags };
        const set = await withRetry(() => resolvePartners({ city, intent }), "resolve_partners");
        lastSet = set;
        return {
          tier1: renderTier1(set),
          metaSummary:
            `${set.meta.totalReturned}/${set.meta.minRequired} across [${set.citiesUsed.join(", ")}]; ` +
            `minMet=${set.meta.minMet}; cappedAtMax=${set.meta.cappedAtMax}; ` +
            `warnings=${set.meta.warnings.join(" | ") || "(none)"}`,
        };
      },
    },
    build_recommendations: {
      description:
        "Turn the resolved set into the final N recommendations with full profile text (Tier 2). " +
        "Call this after resolve_partners.",
      inputSchema: z.object({ finalRecommendations: z.number().default(5) }),
      execute: async ({ finalRecommendations }: { finalRecommendations: number }) => {
        if (!lastSet) throw new Error("build_recommendations called before resolve_partners");
        const out = await withRetry(
          () => buildRecommendations({ set: lastSet as ResolvedPartnerSet, finalRecommendations }),
          "build_recommendations",
        );
        const tier2 = renderTier2(out.recommendations, {
          requestedCity: out.requestedCity,
          includeContactInShortlist: out.includeContactInShortlist,
        });
        const shortlistForCurator = [...lastSet.home, ...lastSet.filled]
          .slice(0, finalRecommendations)
          .map((p) => ({
            id: p.id,
            name: p.name,
            city: p.city,
            tags: p.tags,
            summary: p.summary,
            website_url: p.website_url,
            source: p.source,
            sourceCity: p.sourceCity,
            similarity: p.similarity,
            distanceKm: p.distanceKm,
          }));
        return { disclosure: out.disclosure, tier2, shortlistForCurator };
      },
    },
    delegate_to_curator: {
      description:
        "Delegate the shortlist to the partner-curator subagent for fit-ranking and justification. " +
        "You must always call this before answering, once you have a shortlist from build_recommendations.",
      inputSchema: z.object({
        intentText: z.string(),
        intentTags: z.array(z.string()),
        shortlist: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            city: z.string().nullable(),
            tags: z.array(z.string()),
            summary: z.string(),
            website_url: z.string().nullable(),
            source: z.enum(["home", "nearby"]),
            sourceCity: z.string(),
            similarity: z.number().optional(),
            distanceKm: z.number().optional(),
          }),
        ),
      }),
      execute: async ({
        intentText,
        intentTags,
        shortlist,
      }: {
        intentText: string;
        intentTags: string[];
        shortlist: unknown[];
      }) => withRetry(() => runCurator({ text: intentText, tags: intentTags }, shortlist), "delegate_to_curator"),
    },
    get_partner_details: {
      description:
        "Look up ONE partner's full profile by id. Only for follow-up questions when the profile " +
        "is no longer in context — never re-run resolve_partners for a detail question.",
      inputSchema: z.object({ partnerId: z.number() }),
      execute: async ({ partnerId }: { partnerId: number }) =>
        withRetry(() => getPartnerDetails({ partnerId }), "get_partner_details"),
    },
  };
}

interface TurnResult {
  userTurn: string;
  agentResponse: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  stepCount: number;
}

async function runCase(testCase: { id: number; turns: string[] }): Promise<TurnResult[]> {
  const tools = makeTools();
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const turnResults: TurnResult[] = [];

  for (const turnText of testCase.turns) {
    messages.push({ role: "user", content: turnText });
    await sleep(TURN_DELAY_MS);
    const result = await withRetry(
      () =>
        generateText({
          model: getAzureChatModel(),
          system: SYSTEM_PROMPT,
          messages,
          tools,
          stopWhen: stepCountIs(8),
        }),
      `case ${testCase.id} turn`,
    );
    messages.push({ role: "assistant", content: result.text });
    const toolCalls = (result.steps ?? []).flatMap((step) =>
      (step.toolCalls ?? []).map((tc) => ({ name: tc.toolName, input: tc.input })),
    );
    turnResults.push({
      userTurn: turnText,
      agentResponse: result.text,
      toolCalls,
      stepCount: result.steps?.length ?? 0,
    });
  }
  return turnResults;
}

async function main() {
  const args = process.argv.slice(2);
  const pilotOnly = args.includes("--pilot");
  const idsArg = args.find((a) => a.startsWith("--ids="));
  const ids = idsArg ? idsArg.split("=")[1].split(",").map(Number) : null;

  const cases = dataset.cases.filter((c) => {
    if (ids) return ids.includes(c.id);
    if (pilotOnly) return (dataset.meta.pilotCaseIds as number[]).includes(c.id);
    return true;
  });

  console.log(`Running ${cases.length} case(s)${pilotOnly ? " (pilot)" : ""}...\n`);
  const results: Array<{
    id: number;
    category: string;
    turns: TurnResult[];
    error: string | null;
  }> = [];

  for (const [i, c] of cases.entries()) {
    console.log(`[${i + 1}/${cases.length}] Case ${c.id} — ${c.category}`);
    try {
      const turns = await runCase(c as { id: number; turns: string[] });
      results.push({ id: c.id, category: c.category, turns, error: null });
      console.log(`  done (${turns.length} turn(s)).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}`);
      results.push({ id: c.id, category: c.category, turns: [], error: msg });
    }
    if (i < cases.length - 1) await sleep(CASE_DELAY_MS);
  }

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `run-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
