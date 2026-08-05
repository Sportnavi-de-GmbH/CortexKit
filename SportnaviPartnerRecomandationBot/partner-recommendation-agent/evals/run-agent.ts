/**
 * evals/run-agent.ts — drives the CURRENT agent stack for evaluation.
 *
 * Replaces tests/agent-test/run-cases.ts, which still wires the retired
 * three-tool chain (`extract_city` → `resolve_partners` →
 * `build_recommendations`) and reads
 * `agent/subagents/partner-curator/instructions.md` — a directory that no
 * longer exists, so that harness cannot run at all.
 *
 * What this drives: the real `instructions.md` + generated coverage list as
 * the system prompt, and the real `lib/partners/*` pipeline behind the same
 * TWO tools production exposes (`find_partners`, `get_partner_details`),
 * through the AI SDK's own tool-calling loop. The model decides what to call.
 *
 * Honest scope note: this is the AI SDK loop, not eve's runtime. It exercises
 * the same prompt, tools, model and data — not eve's session/compaction layer.
 *
 * ── Why it captures tool RESULTS, not just tool calls ──────────────────────
 * The single most important metric here is "did the agent name a partner that
 * no tool returned" (CLAUDE.md §11). That cannot be judged from the answer
 * text alone — it needs the ground-truth corpus of what the tools actually
 * handed back. So every tool result is recorded into `grounding`:
 * partner names, ids, phone numbers, emails and URLs. Evaluators compare the
 * answer against that corpus deterministically, with no LLM in the loop.
 */
import "../lib/load-env";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { getAzureChatModel } from "../lib/llm";
import { DEFAULT_CONFIG } from "../agent/config/partner-injection.config";
import { resolveCityFuzzy } from "../lib/partners/extract-city";
import { resolvePartners } from "../lib/partners/resolve-partners";
import { buildRecommendations } from "../lib/partners/build-recommendations";
import { getPartnerDetails } from "../lib/partners/get-partner-details";
import { renderTier2 } from "../lib/partners/render-context";
import { getSupabase } from "../lib/supabase";
import { invalidateSearchCache } from "../lib/partners/search-cache";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, "..", "agent");

const INSTRUCTIONS = fs.readFileSync(path.join(AGENT_DIR, "instructions.md"), "utf8");
const COVERAGE = fs.readFileSync(
  path.join(AGENT_DIR, "instructions", "002-city-coverage.md"),
  "utf8",
);
export const SYSTEM_PROMPT = `${INSTRUCTIONS}\n\n---\n\n${COVERAGE}`;

// The Azure deployment (gpt-4.1, germanywestcentral) has a low tokens-per-minute
// quota, and the wide-context config sends ~42k tokens of profile text per
// search — so a single case can exhaust a minute's budget on its own. Pacing is
// deliberately generous: an eval that dies on 429s produces no signal at all,
// and a rate-limit error is indistinguishable from a real failure in the report.
const TURN_DELAY_MS = 6000;
const MAX_RETRY_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_RETRY_ATTEMPTS || !/429|rate.?limit|too many requests/i.test(msg)) throw err;
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`  [retry] ${label} rate-limited (${attempt}/${MAX_RETRY_ATTEMPTS}), waiting ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

/** Ground truth accumulated from tool results — what the agent was ALLOWED to say. */
export interface GroundingCorpus {
  /** Partner display names returned by any tool this conversation. */
  partnerNames: string[];
  partnerIds: number[];
  /** Contact strings that literally appeared in a returned profile. */
  phones: string[];
  emails: string[];
  urls: string[];
  /** Canonical city names the pipeline actually resolved and searched. */
  citiesSearched: string[];
  /** Raw profile text handed to the model — the corpus for "is this fact supported". */
  profileText: string;
  /** Disclosure lines produced by the pipeline. */
  disclosures: string[];
  /** True when a tool returned needsClarification (no coverage / no city). */
  needsClarification: boolean;
}

export interface TurnResult {
  userTurn: string;
  answer: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  stepCount: number;
  grounding: GroundingCorpus;
}

const CONTACT_PATTERNS = {
  phone: /(?:Telefon:\s*)(\+?[\d\s/()-]{6,})/gi,
  email: /(?:E-Mail:\s*)([^\s]+)/gi,
  url: /(https?:\/\/[^\s)]+)/gi,
};

function harvestContacts(profile: string, into: GroundingCorpus): void {
  for (const [kind, re] of Object.entries(CONTACT_PATTERNS)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(profile)) !== null) {
      const value = (m[1] ?? "").trim();
      if (!value || value.toLowerCase() === "not_available") continue;
      const bucket = kind === "phone" ? into.phones : kind === "email" ? into.emails : into.urls;
      if (!bucket.includes(value)) bucket.push(value);
    }
  }
}

function emptyCorpus(): GroundingCorpus {
  return {
    partnerNames: [],
    partnerIds: [],
    phones: [],
    emails: [],
    urls: [],
    citiesSearched: [],
    profileText: "",
    disclosures: [],
    needsClarification: false,
  };
}

/**
 * The two production tools, rebuilt over the same lib functions. Kept
 * deliberately close to `agent/tools/*.ts` — descriptions included, since the
 * description is part of what the model is being evaluated against.
 */
function makeTools(corpus: GroundingCorpus) {
  return {
    find_partners: tool({
      description:
        "Find and rank sports/wellness partners for a city-based request in ONE call. " +
        "Pass the city exactly as the user wrote it (may be misspelled/abbreviated) plus " +
        "a short description of what they want. Resolves the city, gathers home-city " +
        "partners, fills any gap from nearby cities by similarity, and returns the final " +
        "shortlist with full profiles and an honest coverage disclosure. " +
        "This is the ONLY tool needed for a partner search. " +
        "If it returns NEEDS_CLARIFICATION, ask the user the question it supplies instead of guessing.",
      inputSchema: z.object({
        cityMention: z.string().nullable(),
        intentText: z.string(),
        tags: z.array(z.string()).default([]),
        finalRecommendations: z.number().int().positive().max(DEFAULT_CONFIG.maxPartners).optional(),
      }),
      execute: async (input) => {
        const finalRecommendations = Math.min(
          input.finalRecommendations ?? DEFAULT_CONFIG.finalRecommendations,
          DEFAULT_CONFIG.maxPartners,
        );
        if (!input.cityMention) {
          corpus.needsClarification = true;
          return "NEEDS_CLARIFICATION: In welcher Stadt suchst du? I need a location to find partners near you.";
        }

        const city = await withRetry(
          () => resolveCityFuzzy(input.cityMention as string, getSupabase()),
          "resolve_city_fuzzy",
        );
        if (!city) {
          corpus.needsClarification = true;
          return `NEEDS_CLARIFICATION: I could not find any partners for "${input.cityMention}". Could you confirm the city name, or try a nearby larger town?`;
        }
        if (city.confidence < DEFAULT_CONFIG.cityConfidenceMin && DEFAULT_CONFIG.ambiguityPolicy === "ask") {
          corpus.needsClarification = true;
          return `NEEDS_CLARIFICATION: Did you mean ${city.canonical}? I want to make sure I search the right place.`;
        }

        const set = await withRetry(
          () => resolvePartners({ city, intent: { text: input.intentText, tags: input.tags ?? [] } }),
          "resolve_partners",
        );
        const built = await withRetry(
          () => buildRecommendations({ set, finalRecommendations }),
          "build_recommendations",
        );

        if (!corpus.citiesSearched.includes(city.canonical)) corpus.citiesSearched.push(city.canonical);
        for (const r of built.recommendations) {
          if (!corpus.partnerNames.includes(r.name)) corpus.partnerNames.push(r.name);
          if (!corpus.partnerIds.includes(r.partnerId)) corpus.partnerIds.push(r.partnerId);
          harvestContacts(r.llmProfile, corpus);
        }
        corpus.disclosures.push(built.disclosure);

        const tier2 = renderTier2(built.recommendations, {
          requestedCity: built.requestedCity,
          includeContactInShortlist: built.includeContactInShortlist,
        });
        corpus.profileText += `\n${tier2}`;
        return `${tier2}\n\n${built.disclosure}`;
      },
    }),

    get_partner_details: tool({
      description:
        "Fetch the complete profile of ONE partner by id (address, contact, website, full " +
        "description, courses). Only for follow-up questions when the partner's profile is " +
        "no longer in context — never during a search.",
      inputSchema: z.object({ partnerId: z.number().int().positive() }),
      execute: async ({ partnerId }) => {
        const d = await withRetry(() => getPartnerDetails({ partnerId }), "get_partner_details");
        if (!corpus.partnerNames.includes(d.name)) corpus.partnerNames.push(d.name);
        if (!corpus.partnerIds.includes(d.partnerId)) corpus.partnerIds.push(d.partnerId);
        harvestContacts(d.llmProfile, corpus);
        corpus.profileText += `\n${d.llmProfile}`;
        return d.llmProfile;
      },
    }),
  };
}

export interface RunCaseInput {
  turns: string[];
  /** Clear the in-process search cache first. Default true — an eval must not
   *  inherit a previous case's cached shortlist (that is EC-09's whole point). */
  freshCache?: boolean;
}

export async function runCase(input: RunCaseInput): Promise<TurnResult[]> {
  if (input.freshCache !== false) invalidateSearchCache();

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const results: TurnResult[] = [];

  for (const turnText of input.turns) {
    // Fresh corpus per turn, but carry forward what earlier turns established —
    // a follow-up may legitimately reference a partner from turn 1.
    const corpus: GroundingCorpus = results.length
      ? JSON.parse(JSON.stringify(results[results.length - 1]!.grounding))
      : emptyCorpus();
    corpus.needsClarification = false;

    const tools = makeTools(corpus);
    messages.push({ role: "user", content: turnText });
    await sleep(TURN_DELAY_MS);

    const result = await withRetry(
      () =>
        generateText({
          model: getAzureChatModel(),
          system: SYSTEM_PROMPT,
          messages,
          tools,
          stopWhen: stepCountIs(6),
        }),
      "turn",
    );

    messages.push({ role: "assistant", content: result.text });
    results.push({
      userTurn: turnText,
      answer: result.text,
      toolCalls: (result.steps ?? []).flatMap((s) =>
        (s.toolCalls ?? []).map((tc) => ({ name: tc.toolName, input: tc.input })),
      ),
      stepCount: result.steps?.length ?? 0,
      grounding: corpus,
    });
  }

  return results;
}

/**
 * LangSmith run-function shape: one dataset example in, one flat output out.
 * `finalAnswer` is the last turn's text — every case is written so the last
 * turn carries the behaviour under test.
 */
export async function runForLangSmith(inputs: { turns: string[] }): Promise<Record<string, unknown>> {
  const turns = await runCase({ turns: inputs.turns });
  const last = turns[turns.length - 1]!;
  return {
    finalAnswer: last.answer,
    allAnswers: turns.map((t) => t.answer),
    toolsCalled: turns.flatMap((t) => t.toolCalls.map((c) => c.name)),
    toolInputs: turns.flatMap((t) => t.toolCalls.map((c) => c.input)),
    stepCounts: turns.map((t) => t.stepCount),
    grounding: last.grounding,
    perTurnGrounding: turns.map((t) => t.grounding),
  };
}
