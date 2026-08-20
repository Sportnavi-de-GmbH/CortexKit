import { defineTool } from "eve/tools";
import { z } from "zod";

import { DEFAULT_CONFIG } from "../../agent/config/partner-injection.config";
import {
  buildRecommendations,
  defaultGetPartnerProfiles,
  type BuildRecommendationsOutput,
  type HydratedProfile,
} from "../../lib/partners/build-recommendations";
import { resolveCityFuzzy } from "../../lib/partners/extract-city";
import { emitResolutionEvent } from "../../lib/observability";
import { renderTier2 } from "../../lib/partners/render-context";
import { resolvePartners } from "../../lib/partners/resolve-partners";
import {
  getCachedSearch,
  searchCacheKey,
  setCachedSearch,
  singleFlightSearch,
} from "../../lib/partners/search-cache";
import { getConvex } from "../../lib/convex";
import {
  recordToolCallStart,
  recordKnownNames,
  recordRenderedContext,
  recordSearchLedger,
  admitSearches,
  releaseRenderTokens,
  wasPartnerRendered,
  TOKENS_PER_PARTNER_TIER2,
} from "../../lib/request-budget";
import { withTimeout, timeoutSignal, TimeoutError } from "../../lib/timeout";
import type { Intent, ResolvedPartnerSet } from "../../lib/partners/types";

/**
 * Per-search pipeline deadline (R13 §2 wall-clock arithmetic): searches run
 * in PARALLEL inside one batch, so batch time ≈ slowest search. 12s per
 * search + ~5s p90 model step stays inside the 20s turn budget — the old
 * 15s-per-search-times-N-sequential arithmetic could not.
 */
const SEARCH_DEADLINE_MS = 12_000;
/** Bounds the profile-hydration RPC inside one search. */
const HYDRATION_TIMEOUT_MS = 5_000;

/** A ~15-token stub instead of a ~450-token profile for a partner whose full
 *  profile is already rendered in this conversation epoch (R13 §2/§5). */
const STUB_TOKENS = 15;

// ── Per-search outcome types ────────────────────────────────────────────────

type SearchStatus =
  | "ok"
  | "clarify_no_city"
  | "clarify_city_unknown"
  | "clarify_city_ambiguous"
  | "deferred_budget"
  | "deferred_concurrency"
  | "degraded_timeout"
  | "failed_internal"
  | "duplicate";

interface SearchRequest {
  cityMention: string | null;
  intentText: string;
  tags: string[];
  finalRecommendations?: number;
}

interface SearchOutcome {
  /** 1-based position in the model's `searches` array (user order). */
  index: number;
  cityMention: string | null;
  intentText: string;
  tags: string[];
  status: SearchStatus;
  /** clarify_* only — the question the model relays (rule 8 scope). */
  question?: string;
  /** ok only. */
  built?: BuildRecommendationsOutput;
  resolution?: {
    homeCount: number;
    filledCount: number;
    citiesUsed: string[];
    minMet: boolean;
    cappedAtMax: boolean;
    citiesExhausted: boolean;
    homeQualified?: number;
    allFound: {
      partnerId: number;
      name: string;
      city: string | null;
      source: "home" | "nearby";
      sourceCity: string;
      llmProfile: string;
    }[];
  };
}

/** The cached SEARCH CORE (R13 §7): resolved+scored set + full profile map.
 *  Shortlist sizing, rendering and budget accounting run on EVERY call. */
interface SearchCore {
  set: ResolvedPartnerSet;
  profiles: Map<number, HydratedProfile>;
}

interface FindPartnersResult {
  /** Legacy single-search compatibility for hooks/dev-console: true only when
   *  NO search succeeded and at least one needs a clarification. */
  needsClarification: boolean;
  question?: string;
  batch: { requested: number; executed: number; deferred: number; failed: number };
  searches: SearchOutcome[];
  /** The EXACT model-facing text (also what toModelOutput returns) — rendered
   *  inside execute() so accounting uses the true length (R13 §3.2). */
  renderedText: string;
}

// ── Fixed, laundered templates (rule 9: internals never leak) ───────────────

const TEMPLATES = {
  deferred: (label: string) =>
    `Diese Suche (${label}) habe ich mir vorgemerkt und übernehme sie als Nächstes. ` +
    `/ This search (${label}) is queued — I'll take it on right after this.`,
  timeout: (label: string) =>
    `Die Suche für ${label} hat diesmal zu lange gedauert. ` +
    `/ The ${label} search took too long this time.`,
  failedInternal: (label: string) =>
    `Bei der Suche für ${label} ist gerade etwas schiefgelaufen. ` +
    `/ Something went wrong with the ${label} search just now.`,
  noCity: () =>
    "In welcher Stadt suchst du? / Which city are you looking in? " +
    "I need a location to find partners near you.",
  cityUnknown: (mention: string) =>
    `I could not find any partners for "${mention}". ` +
    "Could you confirm the city name, or try a nearby larger town?",
  cityAmbiguous: (canonical: string) =>
    `Did you mean ${canonical}? I want to make sure I search the right place.`,
} as const;

function searchLabel(s: SearchRequest): string {
  const intent = s.intentText.trim().slice(0, 60);
  return s.cityMention ? `${s.cityMention} · ${intent}` : intent;
}

/**
 * THE ONE-CALL, MULTI-SEARCH PARTNER TOOL (R13 §2 — R06 option B).
 *
 * One tool call carries EVERY search the user's message asks for (up to 10 in
 * the schema); the tool — not the model — decides how many run now (≤3) and
 * defers the rest BY NAME with their parameters echoed. Success and deferral
 * arrive in the same result, so a refusal can never again arrive without the
 * successes the model must present (the 2026-08-20 incident).
 *
 * One atomic budget admission before any await closes the TOCTOU race that
 * let three 42k-token searches through a guard projecting against zero.
 * Promise.allSettled + per-search statuses isolate failures: one timeout or
 * malformed search never touches its siblings or the turn.
 */
export default defineTool({
  description:
    "Find and rank sports/wellness partners for city-based requests in ONE call. " +
    "Pass ALL of the user's (city × activity) searches from this message in the " +
    "searches array, in the order the user asked — never split one message into " +
    "several calls and never pre-filter searches yourself. Each search names the " +
    "city exactly as the user wrote it plus a short description of what they want. " +
    "The tool executes what fits (up to 3 searches) and explicitly reports every " +
    "search it deferred, with its parameters preserved — a deferred search is " +
    "re-issued next turn, which is not a retry of a completed one. " +
    "Call this tool at most once per user message.",
  inputSchema: z.object({
    searches: z
      .array(
        z.object({
          cityMention: z
            .string()
            .nullable()
            .describe(
              "The city/town for this search, verbatim as the user wrote it (may be misspelled). Null if they mentioned no location.",
            ),
          intentText: z
            .string()
            .max(500)
            .describe("Short description of what the user is looking for (activity, level, etc.)."),
          tags: z
            .array(z.string().max(60))
            .max(10)
            .default([])
            .describe("Normalized activity tags implied by the request, e.g. ['yoga'], ['klettern']."),
          finalRecommendations: z
            .number()
            .int()
            .positive()
            .max(DEFAULT_CONFIG.maxPartners)
            .optional()
            .describe(
              `How many partners to show for this search. Defaults to ${DEFAULT_CONFIG.finalRecommendations}, max ${DEFAULT_CONFIG.maxPartners}.`,
            ),
        }),
      )
      .min(1)
      .max(10)
      .describe("One entry per (city × activity) the user asked for, in user order."),
  }),
  async execute(input, ctx) {
    const sessionId = ctx.session.id;
    const requests: SearchRequest[] = input.searches.map((s) => ({
      cityMention: s.cityMention,
      intentText: s.intentText,
      tags: s.tags ?? [],
      finalRecommendations: s.finalRecommendations,
    }));

    // Per-turn gate (tool invocations, steps, wall clock, usage, cost). The
    // search-count/context admission below is a separate, atomic decision.
    const gate = recordToolCallStart(sessionId);
    if (!gate.ok) {
      const outcomes: SearchOutcome[] = requests.map((r, i) => ({
        index: i + 1,
        cityMention: r.cityMention,
        intentText: r.intentText,
        tags: r.tags,
        status: "deferred_budget" as const,
      }));
      return finalizeResult(requests, outcomes);
    }

    // Classify up-front, in user order:
    //  - null city → clarification (consumes no admission slot);
    //  - duplicate of an earlier entry in THIS batch → zero-cost pointer;
    //  - the rest are actionable and subject to admission.
    const outcomes: SearchOutcome[] = [];
    const seenKeys = new Set<string>();
    const actionable: { req: SearchRequest; outcome: SearchOutcome; coreKey: string }[] = [];
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i]!;
      const outcome: SearchOutcome = {
        index: i + 1,
        cityMention: req.cityMention,
        intentText: req.intentText,
        tags: req.tags,
        status: "ok",
      };
      outcomes.push(outcome);
      if (!req.cityMention) {
        outcome.status = "clarify_no_city";
        outcome.question = TEMPLATES.noCity();
        continue;
      }
      const coreKey = searchCacheKey({
        cityMention: req.cityMention,
        tags: req.tags,
        intentText: req.intentText,
      });
      if (seenKeys.has(coreKey)) {
        outcome.status = "duplicate";
        continue;
      }
      seenKeys.add(coreKey);
      actionable.push({ req, outcome, coreKey });
    }

    // ONE atomic admission decision (reads + reservation in the same
    // synchronous frame — no TOCTOU). Entries beyond the admitted count are
    // deferred IN USER ORDER, never chosen by the model or the scheduler.
    const admission = admitSearches(sessionId, actionable.length);
    const admitted = actionable.slice(0, admission.admitted);
    for (const { outcome } of actionable.slice(admission.admitted)) {
      outcome.status =
        admission.deferredReason === "budget" ? "deferred_budget" : "deferred_concurrency";
    }

    try {
      // Run the admitted searches CONCURRENTLY (≤3 — the semaphore is the
      // admission itself). allSettled + per-search deadline: one slow or
      // failing search never touches its siblings.
      const settled = await Promise.allSettled(
        admitted.map(({ req, coreKey }) =>
          withTimeout(runSearchCore(req, coreKey), SEARCH_DEADLINE_MS, "find_partners.search"),
        ),
      );

      for (let i = 0; i < admitted.length; i++) {
        const { req, outcome } = admitted[i]!;
        const result = settled[i]!;
        if (result.status === "rejected") {
          const err = result.reason;
          if (err instanceof TimeoutError) {
            outcome.status = "degraded_timeout";
          } else {
            outcome.status = "failed_internal";
          }
          continue;
        }
        const core = result.value;
        if (core.kind === "city_unknown") {
          outcome.status = "clarify_city_unknown";
          outcome.question = TEMPLATES.cityUnknown(req.cityMention ?? "");
          continue;
        }
        if (core.kind === "city_ambiguous") {
          outcome.status = "clarify_city_ambiguous";
          outcome.question = TEMPLATES.cityAmbiguous(core.canonical);
          continue;
        }
        outcome.status = "ok";
        (outcome as SearchOutcome & { core?: SearchCore }).core = core.core;
      }

      // ── Presentation phase: sequential, USER ORDER, against the real
      // running budget — a thin city releases its surplus to later searches
      // deterministically (R13 §3.3). Runs for cache hits too (R04). ────────
      let availableTokens = admission.admitted * admission.allotmentTokens;
      let remainingOk = outcomes.filter(
        (o) => o.status === "ok" && (o as SearchOutcome & { core?: SearchCore }).core,
      ).length;
      const renderedThisBatch = new Set<number>();
      const sections: string[] = [];

      for (const outcome of outcomes) {
        const core = (outcome as SearchOutcome & { core?: SearchCore }).core;
        if (outcome.status !== "ok" || !core) continue;

        const share = Math.floor(availableTokens / Math.max(1, remainingOk));
        const maxShown = Math.max(1, Math.floor(share / TOKENS_PER_PARTNER_TIER2));
        const built = await buildRecommendations(
          {
            set: core.set,
            finalRecommendations: Math.min(
              outcome.index >= 1
                ? (requests[outcome.index - 1]!.finalRecommendations ??
                    DEFAULT_CONFIG.finalRecommendations)
                : DEFAULT_CONFIG.finalRecommendations,
              DEFAULT_CONFIG.maxPartners,
            ),
            maxShown,
          },
          { profiles: core.profiles },
        );
        outcome.built = built;
        outcome.resolution = buildResolutionSummary(core);

        // Cross-search / cross-turn dedup by id (R13 §2): a partner whose
        // full profile is already live in this conversation epoch (or earlier
        // in this batch) renders as a ~15-token stub, never a second 450-token
        // profile — and is NEVER silently dropped.
        const fresh = built.recommendations.filter(
          (r) => !renderedThisBatch.has(r.partnerId) && !wasPartnerRendered(sessionId, r.partnerId),
        );
        const stubs = built.recommendations.filter((r) => !fresh.includes(r));
        for (const r of built.recommendations) renderedThisBatch.add(r.partnerId);

        const header = `=== SEARCH ${outcome.index}/${requests.length} — ${searchLabel(requests[outcome.index - 1]!)} === STATUS: ok`;
        const body = renderTier2(fresh, {
          requestedCity: built.requestedCity,
          includeContactInShortlist: built.includeContactInShortlist,
        });
        const stubLines = stubs
          .map(
            (r) =>
              `# Partner ${r.partnerId} — ${r.name} (${r.city ?? "unknown"})   [full profile already shown above/earlier in this conversation]`,
          )
          .join("\n");
        const section = [header, body, stubLines, `Disclosure: ${built.disclosure}`]
          .filter((part) => part.trim().length > 0)
          .join("\n\n");
        sections.push(section);

        // Exact accounting on the EXACT rendered text — fresh and cached
        // paths identically (R04), headers and disclosure included (R13 §3.2).
        recordRenderedContext(sessionId, section.length);
        recordKnownNames(
          sessionId,
          built.recommendations.map((r) => r.name),
        );
        recordSearchLedger(sessionId, {
          city: built.requestedCity,
          intentText: outcome.intentText,
          tags: outcome.tags,
          foundCount: built.counts.resolvedTotal,
          shownCount: built.counts.shown,
          shownPartners: built.recommendations.map((r) => ({ id: r.partnerId, name: r.name })),
        });

        availableTokens = Math.max(
          0,
          availableTokens - (Math.ceil(section.length / 4) + stubs.length * STUB_TOKENS),
        );
        remainingOk -= 1;

        // Cache the search core (never clarifications/failures) so repeats
        // and "show me more" re-pulls are deterministic and DB-free.
        const coreKey = searchCacheKey({
          cityMention: outcome.cityMention ?? "",
          tags: outcome.tags,
          intentText: outcome.intentText,
        });
        setCachedSearch(coreKey, core);
      }

      // The search core (with its profile Map) is working state, NOT part of
      // the tool result — a Map is not JSON-serializable and eve rejects the
      // whole result over it. Everything the dev console needs is already in
      // `resolution` (plain objects).
      for (const o of outcomes) {
        delete (o as SearchOutcome & { core?: SearchCore }).core;
      }
      return finalizeResult(requests, outcomes, sections);
    } finally {
      // The reservation did its job (correct projections while we ran);
      // actual usage is now committed via recordRenderedContext, so release
      // the full reservation — on every path, including throws.
      releaseRenderTokens(sessionId, admission.admitted * admission.allotmentTokens);
    }
  },

  // The model sees EXACTLY the text rendered (and accounted for) in execute().
  toModelOutput(output) {
    return { type: "text" as const, value: output.renderedText };
  },
});

// ── Search core: resolve + score + hydrate (cacheable; single-flight) ───────

type CoreResult =
  | { kind: "ok"; core: SearchCore }
  | { kind: "city_unknown" }
  | { kind: "city_ambiguous"; canonical: string };

async function runSearchCore(req: SearchRequest, coreKey: string): Promise<CoreResult> {
  const cached = getCachedSearch<SearchCore>(coreKey);
  if (cached) return { kind: "ok", core: cached };

  return singleFlightSearch<CoreResult>(coreKey, async () => {
    const again = getCachedSearch<SearchCore>(coreKey);
    if (again) return { kind: "ok", core: again };

    const city = await resolveCityFuzzy(req.cityMention as string, getConvex());
    if (!city) return { kind: "city_unknown" };
    if (
      city.confidence < DEFAULT_CONFIG.cityConfidenceMin &&
      DEFAULT_CONFIG.ambiguityPolicy === "ask"
    ) {
      return { kind: "city_ambiguous", canonical: city.canonical };
    }

    const intent: Intent = { text: req.intentText, tags: req.tags };
    const set = await resolvePartners({ city, intent });

    // Fire-and-forget structured resolution event — never throws, never
    // blocks the tool response (lib/observability.ts).
    try {
      emitResolutionEvent(set, { requestId: crypto.randomUUID() });
    } catch {
      // emitResolutionEvent swallows internally; defense in depth per M9.
    }

    // Hydrate the FULL resolved set once (R13 §7): the shortlist renders from
    // this map with zero further DB work, on this call and on every cache hit.
    const allResolved = [...set.home, ...set.filled];
    let profiles = new Map<number, HydratedProfile>();
    if (allResolved.length > 0) {
      profiles = await defaultGetPartnerProfiles(
        allResolved.map((p) => p.id),
        getConvex(),
        timeoutSignal(HYDRATION_TIMEOUT_MS),
      );
    }
    return { kind: "ok", core: { set, profiles } };
  });
}

function buildResolutionSummary(core: SearchCore): NonNullable<SearchOutcome["resolution"]> {
  const { set, profiles } = core;
  const allResolved = [...set.home, ...set.filled];
  return {
    homeCount: set.home.length,
    filledCount: set.filled.length,
    citiesUsed: set.citiesUsed,
    minMet: set.meta.minMet,
    cappedAtMax: set.meta.cappedAtMax,
    citiesExhausted: set.meta.citiesExhausted,
    homeQualified: set.meta.homeQualified,
    allFound: allResolved.map((p) => ({
      partnerId: p.id,
      name: profiles.get(p.id)?.name ?? p.name,
      city: profiles.get(p.id)?.city ?? p.city,
      source: p.source,
      sourceCity: p.sourceCity,
      llmProfile: profiles.get(p.id)?.llmProfile ?? p.summary,
    })),
  };
}

// ── Batch rendering of non-ok statuses + the closing directive ─────────────

function finalizeResult(
  requests: SearchRequest[],
  outcomes: SearchOutcome[],
  okSections: string[] = [],
): FindPartnersResult {
  const executed = outcomes.filter((o) => o.status === "ok" && o.built).length;
  const deferred = outcomes.filter(
    (o) => o.status === "deferred_budget" || o.status === "deferred_concurrency",
  ).length;
  const failed = outcomes.filter(
    (o) => o.status === "degraded_timeout" || o.status === "failed_internal",
  ).length;

  const sections: string[] = [...okSections];
  for (const o of outcomes) {
    const label = searchLabel(requests[o.index - 1]!);
    const head = (status: string) =>
      `=== SEARCH ${o.index}/${requests.length} — ${label} === STATUS: ${status}`;
    switch (o.status) {
      case "ok":
        break; // rendered in the presentation phase
      case "duplicate":
        sections.push(
          `${head("duplicate")}\nSame search as an earlier entry in this call — its results above cover this one.`,
        );
        break;
      case "clarify_no_city":
      case "clarify_city_unknown":
      case "clarify_city_ambiguous":
        sections.push(
          `${head(o.status)}\nNEEDS_CLARIFICATION[${o.status.replace("clarify_", "")}]: ${o.question ?? ""}`,
        );
        break;
      case "deferred_budget":
      case "deferred_concurrency":
        sections.push(
          `${head(o.status)}\nDEFERRED — nothing is wrong with this request; it simply did not fit this turn.\n` +
            `Params (re-issue these verbatim next turn): city="${o.cityMention ?? ""}", intent="${o.intentText}", tags=[${o.tags.join(", ")}]\n` +
            `Suggested user phrasing: ${TEMPLATES.deferred(label)}`,
        );
        break;
      case "degraded_timeout":
        sections.push(
          `${head("degraded_timeout")}\nThis search timed out. You may offer ONE retry next turn — do not retry now.\n` +
            `Params: city="${o.cityMention ?? ""}", intent="${o.intentText}", tags=[${o.tags.join(", ")}]\n` +
            `Suggested user phrasing: ${TEMPLATES.timeout(label)}`,
        );
        break;
      case "failed_internal":
        sections.push(
          `${head("failed_internal")}\nThis search failed internally. Treat it like a timeout: offer a retry next turn, never quote error details.\n` +
            `Suggested user phrasing: ${TEMPLATES.failedInternal(label)}`,
        );
        break;
    }
  }

  const headline = `BATCH RESULT — ${executed} of ${requests.length} search(es) executed, ${deferred} deferred, ${failed} failed.`;
  const directive =
    executed > 0
      ? "DIRECTIVE: Present the executed results NOW, fully. Then, in the SAME reply, mention any deferred/failed searches as YOUR plan for what happens next (one warm sentence, e.g. the suggested phrasings above). NEVER discard the results above, NEVER ask the user to choose or repeat anything they already said, and NEVER end this turn with only a question."
      : deferred + failed > 0
        ? "DIRECTIVE: No search completed this turn. Tell the user warmly that you have their request noted (restate the cities/activities from their message) and that you'll run it next — ask only whether to go ahead, never to re-supply information."
        : "DIRECTIVE: Ask the clarification question(s) above — one short, warm question. Offer real covered cities or activity buckets as choices where that helps.";

  const renderedText = [headline, ...sections, directive].join("\n\n");

  const firstClarify = outcomes.find((o) => o.status.startsWith("clarify_"));
  return {
    needsClarification: executed === 0 && firstClarify !== undefined,
    question: executed === 0 ? firstClarify?.question : undefined,
    batch: { requested: requests.length, executed, deferred, failed },
    searches: outcomes,
    renderedText,
  };
}
