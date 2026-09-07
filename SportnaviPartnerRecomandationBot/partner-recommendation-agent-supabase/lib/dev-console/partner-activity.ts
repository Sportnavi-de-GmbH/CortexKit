/**
 * lib/dev-console/partner-activity.ts
 *
 * Derives the dev console's "Partner Resolution" card content purely from the
 * client-visible message stream — no new backend route. eve hands channel/UI
 * code the FULL structured tool `execute()` return value on a dynamic-tool
 * part's `output` (only `toModelOutput` trims what the LLM itself sees), so
 * the card can read everything the search produced without costing the model
 * a single prompt token.
 *
 * TWO SHAPES ARE SUPPORTED, because the agent was restructured for speed:
 *
 *  1. `find_partners` (current) — ONE call does the whole search. Its output
 *     is `BuildRecommendationsOutput` plus a `resolution` summary block
 *     (home/filled counts, cities used, meta flags) that exists purely for
 *     this card. One part = one complete entry, no pairing needed.
 *
 *  2. `resolve_partners` + `build_recommendations` (legacy) — the older
 *     three-tool chain. Kept so historical sessions and any fallback path
 *     still render. Pairs "the next build_recommendations after this
 *     resolve_partners" within a turn.
 *
 * When the legacy tools are removed, delete the pairing branch below; the
 * `find_partners` branch is self-contained.
 */
import type { ResolvedPartnerSet } from "../partners/types";
import type { BuildRecommendationsOutput } from "../partners/build-recommendations";

interface DynamicToolPart {
  type: "dynamic-tool";
  toolName: string;
  state: string;
  output?: unknown;
}

interface MessageLike {
  parts: readonly unknown[];
}

export interface PartnerResolutionEntry {
  id: string;
  requestedCity: string | null;
  homeCount: number;
  filledCount: number;
  citiesUsed: string[];
  minMet: boolean | null;
  cappedAtMax: boolean | null;
  citiesExhausted: boolean | null;
  warnings: string[];
  recommendations: { partnerId: number; name: string; city: string | null; source: "home" | "nearby" }[] | null;
  disclosure: string | null;
  buildError: string | null;
  /** Every partner the resolver found before trimming to the shortlist, with full profile text. */
  allFound: AllFoundPartner[] | null;
}

export interface AllFoundPartner {
  partnerId: number;
  name: string;
  city: string | null;
  source: "home" | "nearby";
  sourceCity: string;
  llmProfile: string;
}

/** The `resolution` summary `find_partners` attaches for this card. */
interface FindPartnersResolution {
  homeCount: number;
  filledCount: number;
  citiesUsed: string[];
  minMet: boolean;
  cappedAtMax: boolean;
  citiesExhausted: boolean;
  allFound: AllFoundPartner[];
}

type FindPartnersOutput = BuildRecommendationsOutput & { resolution: FindPartnersResolution };

function isDynamicToolPart(part: unknown): part is DynamicToolPart {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "dynamic-tool";
}

function isResolvedPartnerSet(output: unknown): output is ResolvedPartnerSet & { setId: string } {
  return typeof output === "object" && output !== null && "requestedCity" in output && "home" in output;
}

function isBuildRecommendationsOutput(output: unknown): output is BuildRecommendationsOutput {
  return typeof output === "object" && output !== null && "recommendations" in output;
}

function isBuildRecommendationsError(output: unknown): output is { error: string } {
  return typeof output === "object" && output !== null && "error" in output && !("recommendations" in output);
}

/** A successful `find_partners` result — carries both the shortlist and the
 *  resolution accounting. Clarification results have neither and are skipped. */
function isFindPartnersOutput(output: unknown): output is FindPartnersOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    "recommendations" in output &&
    "resolution" in output
  );
}

function toEntryRecommendations(
  output: BuildRecommendationsOutput,
): PartnerResolutionEntry["recommendations"] {
  return output.recommendations.map((r) => ({
    partnerId: r.partnerId,
    name: r.name,
    city: r.city,
    source: r.source,
  }));
}

/** One entry per search, newest first. */
export function buildPartnerActivity(messages: readonly MessageLike[]): PartnerResolutionEntry[] {
  const toolParts: DynamicToolPart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (isDynamicToolPart(part) && part.state === "output-available") {
        toolParts.push(part);
      }
    }
  }

  const entries: PartnerResolutionEntry[] = [];

  for (let i = 0; i < toolParts.length; i++) {
    const part = toolParts[i];

    // --- Current path: one find_partners call is one complete entry --------
    if (part.toolName === "find_partners") {
      if (!isFindPartnersOutput(part.output)) continue; // clarification result
      const out = part.output;
      entries.push({
        id: `find-${i}`,
        requestedCity: out.requestedCity ?? null,
        homeCount: out.resolution.homeCount,
        filledCount: out.resolution.filledCount,
        citiesUsed: out.resolution.citiesUsed ?? [],
        minMet: out.resolution.minMet ?? null,
        cappedAtMax: out.resolution.cappedAtMax ?? null,
        citiesExhausted: out.resolution.citiesExhausted ?? null,
        warnings: out.warnings ?? [],
        recommendations: toEntryRecommendations(out),
        disclosure: out.disclosure ?? null,
        buildError: null,
        allFound: out.resolution.allFound ?? null,
      });
      continue;
    }

    // --- Legacy path: resolve_partners paired with build_recommendations ---
    if (part.toolName !== "resolve_partners" || !isResolvedPartnerSet(part.output)) continue;

    const set = part.output;

    // The next build_recommendations after this resolve_partners — but ONLY
    // if it appears before another resolve_partners call. If the agent skips
    // building and moves on to a later resolve+build pair, that later build
    // belongs to the later resolve, so stop scanning and leave this unpaired.
    let pairedBuild: DynamicToolPart | undefined;
    for (let j = i + 1; j < toolParts.length; j++) {
      if (toolParts[j].toolName === "resolve_partners") break;
      if (toolParts[j].toolName === "build_recommendations") {
        pairedBuild = toolParts[j];
        break;
      }
    }

    let recommendations: PartnerResolutionEntry["recommendations"] = null;
    let disclosure: string | null = null;
    let buildError: string | null = null;

    if (pairedBuild) {
      if (isBuildRecommendationsOutput(pairedBuild.output)) {
        recommendations = toEntryRecommendations(pairedBuild.output);
        disclosure = pairedBuild.output.disclosure;
      } else if (isBuildRecommendationsError(pairedBuild.output)) {
        buildError = pairedBuild.output.error;
      }
    }

    entries.push({
      id: `resolve-${i}`,
      requestedCity: set.requestedCity?.canonical ?? null,
      homeCount: set.home?.length ?? 0,
      filledCount: set.filled?.length ?? 0,
      citiesUsed: set.citiesUsed ?? [],
      minMet: set.meta?.minMet ?? null,
      cappedAtMax: set.meta?.cappedAtMax ?? null,
      citiesExhausted: set.meta?.citiesExhausted ?? null,
      warnings: set.meta?.warnings ?? [],
      recommendations,
      disclosure,
      buildError,
      // Legacy path never hydrates full profiles for the whole set — only
      // the lightweight PartnerLite.summary is available here.
      allFound: [...(set.home ?? []), ...(set.filled ?? [])].map((p) => ({
        partnerId: p.id,
        name: p.name,
        city: p.city,
        source: p.source,
        sourceCity: p.sourceCity,
        llmProfile: p.summary,
      })),
    });
  }

  return entries.reverse();
}
