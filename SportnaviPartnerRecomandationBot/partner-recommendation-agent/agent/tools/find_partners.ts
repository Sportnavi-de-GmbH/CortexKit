import { defineTool } from "eve/tools";
import { z } from "zod";

import { DEFAULT_CONFIG } from "../../agent/config/partner-injection.config";
import { buildRecommendations, defaultGetPartnerProfiles } from "../../lib/partners/build-recommendations";
import { resolveCityFuzzy } from "../../lib/partners/extract-city";
import { emitResolutionEvent } from "../../lib/observability";
import { renderTier2 } from "../../lib/partners/render-context";
import { resolvePartners } from "../../lib/partners/resolve-partners";
import { getCachedSearch, searchCacheKey, setCachedSearch } from "../../lib/partners/search-cache";
import { getSupabase } from "../../lib/supabase";
import { recordToolCallStart, recordKnownNames } from "../../lib/request-budget";
import { withTimeout, timeoutSignal, TimeoutError } from "../../lib/timeout";
import type { Intent } from "../../lib/partners/types";
import type { BuildRecommendationsOutput } from "../../lib/partners/build-recommendations";

/** Outer wall-clock deadline for the whole search pipeline (production-
 * readiness review items 3/5) — measured p50-p90 for a search was 7-27s;
 * this is the hard ceiling a hung dependency degrades against instead of
 * blocking the turn indefinitely. Independent of the per-dependency
 * timeouts inside resolve-partners.ts/build-recommendations.ts, which bound
 * individual stages; this bounds the pipeline as a whole. */
const FIND_PARTNERS_TIMEOUT_MS = 15_000;
/** Bounds the profile-hydration RPC build-recommendations.ts makes. */
const HYDRATION_TIMEOUT_MS = 5_000;

/** What a successful search returns — cached and handed to the dev console. */
type FindPartnersResult = BuildRecommendationsOutput & {
  needsClarification: false;
  resolution: {
    homeCount: number;
    filledCount: number;
    citiesUsed: string[];
    minMet: boolean;
    cappedAtMax: boolean;
    citiesExhausted: boolean;
    /**
     * Every partner the resolver found — home city whole plus every gap-fill
     * candidate that passed the similarity floor — BEFORE `buildRecommendations`
     * trims it down to `finalRecommendations`, each with its full rendered
     * `llm_profile` (same batched-hydration path the shortlist uses, just run
     * against the whole resolved set). Dev-console-only (never reaches
     * `toModelOutput`); this is the same public directory data the shortlist
     * already exposes, just for more partners.
     */
    allFound: {
      partnerId: number;
      name: string;
      city: string | null;
      source: "home" | "nearby";
      sourceCity: string;
      llmProfile: string;
    }[];
  };
};

/**
 * THE ONE-CALL PARTNER SEARCH.
 *
 * Replaces the extract_city → resolve_partners → build_recommendations chain
 * with a single tool. Measured motivation (2026-07-31 benchmark, 6 requests):
 *
 *  - That chain cost FOUR model steps per request. Steps 1-3 produced only
 *    17-82 output tokens each — they were pure tool-call dispatch, relaying
 *    data between tools while re-sending the whole ~9.5k-token system prompt
 *    and tool schemas every time. Only step 4 wrote anything a user reads.
 *  - extract_city additionally made a HIDDEN second LLM call (generateObject)
 *    to parse the city out of the user's message — text the main model had
 *    already read. Measured 6.7-14.5 s of pure latency for ~180 tokens of work.
 *
 * Here the main model supplies `cityMention`/`intentText`/`tags` directly as
 * arguments (it has already read the message; naming the city costs it ~30
 * output tokens instead of a whole model round-trip), and everything else runs
 * server-side in one pass.
 *
 * The ambiguity contract is preserved exactly: when the city cannot be
 * resolved, or resolves below `cityConfidenceMin` while `ambiguityPolicy` is
 * "ask", this returns a `needsClarification` result and the model is expected
 * to ask the user — the same decision extract_city used to hand back.
 */
export default defineTool({
  description:
    "Find and rank sports/wellness partners for a city-based request in ONE call. " +
    "Pass the city exactly as the user wrote it (may be misspelled/abbreviated) plus " +
    "a short description of what they want. Resolves the city, gathers home-city " +
    "partners, fills any gap from nearby cities by similarity, and returns the final " +
    "shortlist with full profiles and an honest coverage disclosure. " +
    "This is the ONLY tool needed for a partner search — call it exactly once per search, " +
    "never speculatively and never to re-verify a result you already have. " +
    "If it returns needsClarification, ask the user the question it supplies instead of guessing.",
  inputSchema: z.object({
    cityMention: z
      .string()
      .nullable()
      .describe(
        "The city/town the user asked about, verbatim as they wrote it. Null if they mentioned no location.",
      ),
    intentText: z
      .string()
      .describe("Short description of what the user is looking for (activity, level, etc.)."),
    tags: z
      .array(z.string())
      .default([])
      .describe("Normalized activity tags implied by the request, e.g. ['yoga'], ['klettern']."),
    finalRecommendations: z
      .number()
      .int()
      .positive()
      .max(DEFAULT_CONFIG.maxPartners)
      .optional()
      .describe(
        `How many partners to recommend. Defaults to ${DEFAULT_CONFIG.finalRecommendations}, max ${DEFAULT_CONFIG.maxPartners}.`,
      ),
  }),
  async execute(input, ctx) {
    // THE enforcement point for the per-turn execution budget
    // (production-readiness review items 1/3): no ceiling on reasoning
    // steps/tool calls. eve has no stopWhen/maxSteps primitive and its hooks
    // are observe-only, so this synchronous check — reading state
    // agent/hooks/budget.ts accumulates from step.completed events — is
    // where a runaway turn actually stops doing work. Degrades to the
    // tool's existing needsClarification contract rather than a new shape.
    const budgetCheck = recordToolCallStart(ctx.session.id);
    if (!budgetCheck.ok) {
      return {
        needsClarification: true as const,
        question:
          "I've made too many attempts on this request — could you try asking again, maybe with fewer details at once?",
      };
    }

    const intent: Intent = { text: input.intentText, tags: input.tags ?? [] };
    // Clamped as well as schema-bounded: this value sizes the id array handed
    // to get_partner_profiles and the number of full profiles rendered into
    // context, so it must never exceed the working set the config allows.
    const finalRecommendations = Math.min(
      input.finalRecommendations ?? DEFAULT_CONFIG.finalRecommendations,
      DEFAULT_CONFIG.maxPartners,
    );

    // Cache lookup BEFORE any I/O. A repeat search for a popular city skips
    // all 5-10 serialized round-trips. Keyed on everything that can change the
    // result — INCLUDING `intentText`, which is the embedding query that
    // decides what gap-fill returns. See lib/partners/search-cache.ts.
    const cacheKey = input.cityMention
      ? searchCacheKey({
          cityMention: input.cityMention,
          tags: intent.tags,
          finalRecommendations,
          intentText: input.intentText,
        })
      : undefined;

    if (cacheKey) {
      const hit = getCachedSearch<FindPartnersResult>(cacheKey);
      if (hit) return hit;
    }

    if (!input.cityMention) {
      return {
        needsClarification: true as const,
        question:
          "In welcher Stadt suchst du? / Which city are you looking in? " +
          "I need a location to find partners near you.",
      };
    }

    const city = await resolveCityFuzzy(input.cityMention, getSupabase());

    if (!city) {
      return {
        needsClarification: true as const,
        question:
          `I could not find any partners for "${input.cityMention}". ` +
          "Could you confirm the city name, or try a nearby larger town?",
      };
    }

    if (
      city.confidence < DEFAULT_CONFIG.cityConfidenceMin &&
      DEFAULT_CONFIG.ambiguityPolicy === "ask"
    ) {
      return {
        needsClarification: true as const,
        question: `Did you mean ${city.canonical}? I want to make sure I search the right place.`,
      };
    }

    // The whole remaining pipeline (resolve + hydrate) is wrapped in one
    // outer wall-clock deadline (production-readiness review items 3/5): a
    // hung Supabase/embedding dependency degrades to the tool's existing
    // needsClarification contract instead of blocking the turn
    // indefinitely. The per-stage timeouts inside resolve-partners.ts and
    // build-recommendations.ts bound individual stages; this bounds the
    // pipeline as a whole regardless of how those stages divide their time.
    async function runSearch(resolvedCity: NonNullable<typeof city>): Promise<FindPartnersResult> {
      const set = await resolvePartners({ city: resolvedCity, intent });

      // Fire-and-forget structured resolution event — never throws, never
      // blocks the tool response (lib/observability.ts).
      try {
        emitResolutionEvent(set, { requestId: crypto.randomUUID() });
      } catch {
        // emitResolutionEvent swallows internally; defense in depth per M9.
      }

      const built = await buildRecommendations(
        { set, finalRecommendations },
        { signal: timeoutSignal(HYDRATION_TIMEOUT_MS) },
      );

      // Hydrate full profiles for EVERY resolved partner (not just the
      // shortlist) so the dev console can show the whole found set as real
      // cards. Same batched RPC buildRecommendations uses internally, just
      // called again against the full id list. Dev-console-only — never sent
      // to the model — so a bigger id list here costs no prompt tokens; it's
      // a second Supabase round-trip per search, not a config-affecting change.
      const allResolved = [...set.home, ...set.filled];
      let allFound: {
        partnerId: number;
        name: string;
        city: string | null;
        source: "home" | "nearby";
        sourceCity: string;
        llmProfile: string;
      }[] = [];
      try {
        const profiles =
          allResolved.length > 0
            ? await defaultGetPartnerProfiles(
                allResolved.map((p) => p.id),
                getSupabase(),
                timeoutSignal(HYDRATION_TIMEOUT_MS),
              )
            : new Map();
        allFound = allResolved.map((p) => ({
          partnerId: p.id,
          name: profiles.get(p.id)?.name ?? p.name,
          city: profiles.get(p.id)?.city ?? p.city,
          source: p.source,
          sourceCity: p.sourceCity,
          llmProfile: profiles.get(p.id)?.llmProfile ?? p.summary,
        }));
      } catch {
        // Dev-console-only enrichment; fall back to the lightweight PartnerLite
        // fields rather than fail the search over a card the model never sees.
        allFound = allResolved.map((p) => ({
          partnerId: p.id,
          name: p.name,
          city: p.city,
          source: p.source,
          sourceCity: p.sourceCity,
          llmProfile: p.summary,
        }));
      }

      // `resolution` carries the search's own accounting for the dev console's
      // Partner Resolution card. eve gives channel/UI code the FULL execute()
      // return value while `toModelOutput` trims what the model sees, so this
      // costs zero prompt tokens. It is a flat summary rather than the raw
      // ResolvedPartnerSet because `set.requestedCity` is a ResolvedCity object
      // and `built.requestedCity` is the canonical string — spreading both
      // would collide. `built.warnings` already includes `set.meta.warnings`.
      return {
        needsClarification: false as const,
        ...built,
        resolution: {
          homeCount: set.home.length,
          filledCount: set.filled.length,
          citiesUsed: set.citiesUsed,
          minMet: set.meta.minMet,
          cappedAtMax: set.meta.cappedAtMax,
          citiesExhausted: set.meta.citiesExhausted,
          allFound,
        },
      };
    }

    let result: FindPartnersResult;
    try {
      result = await withTimeout(runSearch(city), FIND_PARTNERS_TIMEOUT_MS, "find_partners");
    } catch (err) {
      if (err instanceof TimeoutError) {
        return {
          needsClarification: true as const,
          question:
            "That search is taking longer than expected — could you try again, maybe with a narrower request?",
        };
      }
      throw err;
    }

    // Record this turn's shortlist names for the live grounding tripwire
    // (production-readiness review item 4) — see lib/partners/grounding-check.ts.
    recordKnownNames(
      ctx.session.id,
      result.recommendations.map((r) => r.name),
    );

    // Only successful searches are cached. Clarification results are cheap to
    // re-derive and depend on wording, and caching "we couldn't find that
    // city" would outlive a partner import that fixes exactly that.
    if (cacheKey) setCachedSearch(cacheKey, result);
    return result;
  },

  // The model sees Tier-2 (full profile blocks for the shortlist) + the honest
  // disclosure line — never the raw structured output. Same contract as the
  // build_recommendations tool it replaces; channel/test code still receives
  // the full execute() return value.
  toModelOutput(output) {
    if (output.needsClarification) {
      return { type: "text" as const, value: `NEEDS_CLARIFICATION: ${output.question}` };
    }
    return {
      type: "text" as const,
      value: `${renderTier2(output.recommendations, {
        requestedCity: output.requestedCity,
        includeContactInShortlist: output.includeContactInShortlist,
      })}\n\n${output.disclosure}`,
    };
  },
});
