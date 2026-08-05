/**
 * lib/partners/extract-city.ts
 *
 * Parse a free-form (often German) partner request into a resolved city and
 * the user's intent. Ported from eve-agent-plan/agent/tools/extract-city.ts
 * (design reference, read-only).
 *
 * Two integration points, both injectable so tests never touch the network:
 *  1) Structured LLM extraction (city mention + intent text + tags).
 *  2) `resolve_city_fuzzy(place)` RPC to resolve messy/abbreviated spellings.
 *
 * DEVIATION from the design reference (verified live against the DB, see
 * M3a report): `resolve_city_fuzzy` groups by exact `partners.city` and ends
 * with `ORDER BY sim DESC, count(*) DESC LIMIT 1` — it returns AT MOST ONE
 * row (the single best-matching city), not "one row per spelling variant".
 * So `aliases` here is built from that single canonical city label, not a
 * fan-out of rows ≥ a similarity floor.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateObject } from "ai";
import { z } from "zod";
import { getSupabase } from "../supabase";
import { getAzureChatModel } from "../llm";
import { DEFAULT_CONFIG, type AmbiguityPolicy } from "../../agent/config/partner-injection.config";
import type { Intent, ResolvedCity } from "./types";

export interface ExtractCityInput {
  requestText: string;
  /** Optional location the channel already knows (e.g. from the app). */
  channelCity?: string;
  /** Optional overrides for the ambiguity decision; merged over DEFAULT_CONFIG. */
  config?: {
    cityConfidenceMin?: number;
    ambiguityPolicy?: AmbiguityPolicy;
  };
}

export interface ExtractCityOutput {
  city: ResolvedCity | null; // null when no city could be determined (E4/E20)
  intent: Intent;
  /**
   * True when a city WAS resolved but its confidence is below
   * config.cityConfidenceMin (E1). Always false when city is null — there is
   * no confidence to evaluate, and that case is handled by the "no city"
   * flow instead.
   */
  lowConfidence: boolean;
  /** Passthrough of config.ambiguityPolicy so the agent can act on
   * `lowConfidence` without hardcoding the default itself. */
  ambiguityPolicy: AmbiguityPolicy;
}

interface ParsedRequest {
  city: string | null;
  intentText: string;
  tags: string[];
}

/** Injectable dependencies — lets tests mock the LLM and the DB call. */
export interface ExtractCityDeps {
  /** Structured extraction; defaults to a generateObject call against Azure. */
  extractFn?: (requestText: string) => Promise<ParsedRequest>;
  /** Supabase client; defaults to the shared service-role singleton. */
  supabase?: SupabaseClient;
}

const extractionSchema = z.object({
  city: z
    .string()
    .nullable()
    .describe(
      "The city/town the user is asking about, verbatim as mentioned (may be misspelled or abbreviated). Null if no location is mentioned.",
    ),
  intentText: z
    .string()
    .describe(
      "A short free-text description of what the user is looking for (activity, level, etc.), suitable as a search query.",
    ),
  tags: z
    .array(z.string())
    .describe("Optional normalized activity/category tags implied by the request (e.g. ['klettern'])."),
});

async function defaultExtractFn(requestText: string): Promise<ParsedRequest> {
  const { object } = await generateObject({
    model: getAzureChatModel(),
    schema: extractionSchema,
    prompt:
      "Extract the city and search intent from this partner request (often German). " +
      "Do not invent a city if none is mentioned.\n\nRequest: " +
      requestText,
  });
  return object;
}

/**
 * Resolves `place` to a {@link ResolvedCity} via `resolve_city_fuzzy`, or
 * `null` if no active-partner city matches above the RPC's similarity floor
 * (0.4, enforced inside the function body — E2).
 */
export async function resolveCityFuzzy(
  place: string,
  supabase: SupabaseClient,
): Promise<ResolvedCity | null> {
  const { data, error } = await supabase.rpc("resolve_city_fuzzy", { place });
  if (error) {
    throw new Error(`resolveCityFuzzy: resolve_city_fuzzy RPC failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{ city: string; lat: number; lon: number; sim: number }>;
  const best = rows[0];
  if (!best) {
    return null;
  }

  // NOTE: `partnerCount` is deliberately 0 here. A second, fully-serialized
  // `count(*)` query used to run at this point to populate it — and nothing
  // in the request path ever read the result (grep: only types, Zod schemas
  // and test fixtures reference it). It cost one blocking round-trip on
  // EVERY search for a value that was thrown away. The real home-city count
  // is known a moment later anyway, from the rows getPartnersByCity returns.
  return {
    input: place,
    canonical: best.city,
    aliases: [best.city],
    centroid: { lat: best.lat, lng: best.lon },
    partnerCount: 0,
    confidence: best.sim,
  };
}

export async function extractCityAndIntent(
  input: ExtractCityInput,
  deps: ExtractCityDeps = {},
): Promise<ExtractCityOutput> {
  const extractFn = deps.extractFn ?? defaultExtractFn;

  const cityConfidenceMin = input.config?.cityConfidenceMin ?? DEFAULT_CONFIG.cityConfidenceMin;
  const ambiguityPolicy = input.config?.ambiguityPolicy ?? DEFAULT_CONFIG.ambiguityPolicy;

  const parsed = await extractFn(input.requestText);
  const cityInput = parsed.city ?? input.channelCity ?? null;

  const intent: Intent = {
    text: parsed.intentText || input.requestText,
    tags: parsed.tags ?? [],
  };

  if (!cityInput) {
    // agent asks a clarifying question (E4) — no city, so no confidence to evaluate.
    return { city: null, intent, lowConfidence: false, ambiguityPolicy };
  }

  const supabase = deps.supabase ?? getSupabase();
  const resolved = await resolveCityFuzzy(cityInput, supabase);
  if (!resolved) {
    // Unresolvable / no coverage (E2) — return a city stub with confidence 0.
    return {
      city: {
        input: cityInput,
        canonical: cityInput,
        aliases: [],
        centroid: null,
        partnerCount: 0,
        confidence: 0,
      },
      intent,
      lowConfidence: 0 < cityConfidenceMin,
      ambiguityPolicy,
    };
  }

  return {
    city: resolved,
    intent,
    lowConfidence: resolved.confidence < cityConfidenceMin, // E1
    ambiguityPolicy,
  };
}
