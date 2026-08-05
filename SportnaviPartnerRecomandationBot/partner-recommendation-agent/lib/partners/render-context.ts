/**
 * lib/partners/render-context.ts
 *
 * M6 — two-tier context rendering. Turns the structured objects the search
 * pipeline already produces (`ResolvedPartnerSet`, `BuildRecommendationsOutput`)
 * into the plain-text blocks the model actually reads.
 *
 * Design sources (read-only): eve-agent-plan/pseudocode/partner-injection.pseudo.md
 * ("How the full context injection is laid out" + the borrowed-partner block
 * format under STEP 4) and eve-agent-plan/docs/09-context-and-embedding-improvement-plan.md
 * (§7 "Two tiers to protect the context window").
 *
 * Tier 1 (`renderTier1`) — compact candidate lines for the WHOLE working set
 * (up to maxPartners), used for reasoning about coverage/selection. Home
 * ALWAYS first, never scored; nearby always carries its borrow metadata.
 * No profile bodies here — that's what makes it "compact".
 *
 * Tier 2 (`renderTier2`) — full, untruncated `llm_profile` blocks for the
 * FINAL shortlist only (`finalRecommendations`, e.g. 5), the thing the agent
 * actually quotes prices/hours/contact from. Never truncated — owner
 * decision (docs/09 §11: "context quality over token savings").
 */

import type { PartnerLite, ResolvedPartnerSet } from "./types";
import type { Recommendation } from "./build-recommendations";
import { classifyWarning } from "../observability";

/** Lines in `partners.llm_profile` that carry contact info (verified against
 * real rows via Supabase MCP on 2026-07-19 — see M6 report). Filtering these
 * out is the ONLY effect of `includeContactInShortlist: false`; nothing else
 * in the profile is touched. */
const CONTACT_LABELS = ["Adresse:", "Telefon:", "E-Mail:", "Social Media:", "Google Maps:"];

function formatTags(tags: string[]): string {
  return tags.length > 0 ? tags.join(", ") : "(none)";
}

/**
 * Tier 1 — compact one-liner-per-partner rendering of the entire resolved
 * working set (home + filled). Home city is always listed first and never
 * carries similarity/distance (it is never scored — golden rule). The
 * "NEARBY CITY PARTNERS:" section is present ONLY when `set.filled` is
 * non-empty, per the pseudocode layout.
 */
export function renderTier1(set: ResolvedPartnerSet): string {
  const lines: string[] = [];
  const requestedCity = set.requestedCity.canonical;

  lines.push("HOME CITY PARTNERS:");
  for (const p of set.home) {
    lines.push(`  # Partner ${p.id} — ${p.name} (${p.city ?? "unknown"})   [home]`);
    lines.push(`    Tags: ${formatTags(p.tags)}`);
  }

  if (set.filled.length > 0) {
    lines.push("NEARBY CITY PARTNERS:");
    for (const p of set.filled) {
      lines.push(`  # Partner ${p.id} — ${p.name} (${p.city ?? "unknown"})   [nearby]`);
      lines.push(
        `    Borrowed from: ${p.sourceCity}, ~${formatDistance(p.distanceKm)} km from ${requestedCity}`,
      );
      lines.push(`    Similarity score: ${formatSimilarity(p.similarity)}`);
      lines.push(`    Tags: ${formatTags(p.tags)}`);
    }
  }

  return lines.join("\n");
}

/** Fixed, user-safe phrasing per {@link classifyWarning} code. Counts are
 * folded into the phrase where the code has count semantics; codes that
 * describe a single fact (e.g. a clamp) ignore the count and are rendered
 * once regardless of how many raw warnings mapped to them. NEVER include the
 * raw warning text, scores, or database details here — see
 * agent/instructions.md's non-negotiable rule on paraphrasing warnings. */
const WARNING_PHRASES: Record<string, (count: number) => string> = {
  config_min_clamped_to_max: () => "the requested minimum was capped to the configured maximum",
  home_overflow_trimmed: () => "the home city's results were trimmed to the configured maximum",
  nearby_city_lookup_failed: () => "a nearby city was skipped due to a search problem",
  city_search_failed: (n) =>
    `${n} nearby ${n === 1 ? "city was" : "cities were"} skipped due to a search problem`,
  similarity_floor_rejects: (n) =>
    `${n} candidate${n === 1 ? "" : "s"} rejected below the relevance floor`,
  shortfall_below_min: () => "coverage near the requested city fell short of the minimum",
  profile_content_missing: (n) =>
    `${n} partner${n === 1 ? " was" : "s were"} left out because their profile text was unavailable`,
  hydration_incomplete: () => "some partner profiles could not be loaded in full",
  hydration_failed: () => "partner profiles could not be loaded and short summaries were used",
  embedding_degraded: () => "search quality was degraded due to an embedding service issue",
  other: (n) => `${n} other internal issue${n === 1 ? "" : "s"} occurred`,
};

/**
 * A short meta/warnings summary line to accompany Tier 1 in the model-facing
 * tool output — counts and flags only, never raw partner content. Warnings
 * are reclassified via {@link classifyWarning} (the same coded classification
 * used for observability) and rendered as fixed, human-readable phrases —
 * the raw internal warning strings (which may carry DB error text) never
 * reach the model.
 */
export function renderMetaSummary(set: ResolvedPartnerSet): string {
  const m = set.meta;
  const parts = [
    `${m.totalReturned}/${m.minRequired} partners across ${set.citiesUsed.length} cit${set.citiesUsed.length === 1 ? "y" : "ies"} (${set.citiesUsed.join(", ")})`,
    `minMet=${m.minMet}`,
  ];
  if (m.cappedAtMax) parts.push("cappedAtMax=true");
  if (m.citiesExhausted) parts.push("citiesExhausted=true");
  if (m.warnings.length > 0) {
    const counts = new Map<string, number>();
    for (const w of m.warnings) {
      const code = classifyWarning(w);
      // Some warnings (e.g. floor rejects) already carry their own count as
      // a leading integer ("3 nearby candidate(s) rejected..."); prefer that
      // over counting matching warning entries so repeated resolution
      // batches don't undercount. Warnings without a leading count (one
      // warning == one occurrence, e.g. a skipped city) fall back to 1.
      const leading = w.match(/^\d+/)?.[0];
      const inc = leading ? Number.parseInt(leading, 10) : 1;
      counts.set(code, (counts.get(code) ?? 0) + inc);
    }
    const phrases = [...counts.entries()].map(([code, count]) =>
      (WARNING_PHRASES[code] ?? WARNING_PHRASES.other)(count),
    );
    parts.push(`warnings: ${phrases.join(" | ")}`);
  }
  return parts.join("; ");
}

function formatDistance(distanceKm: number | undefined): number {
  return Math.round(distanceKm ?? 0);
}

function formatSimilarity(similarity: number | undefined): string {
  return (similarity ?? 0).toFixed(2);
}

/** Strips ONLY the labeled contact lines from a Tier-2 profile block; every
 * other line (including the free-text "## Kontakt & Anfahrt" prose section,
 * which is not a labeled line) passes through untouched. */
function stripContactLines(profile: string): string {
  return profile
    .split("\n")
    .filter((line) => !CONTACT_LABELS.some((label) => line.trimStart().startsWith(label)))
    .join("\n");
}

export interface RenderTier2Options {
  /** Canonical requested city — used only for nearby "Borrowed from … km from X". */
  requestedCity: string;
  /** Mirrors PartnerInjectionConfig.includeContactInShortlist. Default true. */
  includeContactInShortlist?: boolean;
}

/**
 * Tier 2 — full, untruncated `llm_profile` blocks for the final shortlist
 * (`build_recommendations`' output), each preceded by the same [home]/[nearby]
 * metadata header used elsewhere. The profile text itself is passed through
 * VERBATIM (never re-parsed, never truncated) except for the optional
 * contact-line strip controlled by `includeContactInShortlist`.
 */
export function renderTier2(
  recommendations: Recommendation[],
  opts: RenderTier2Options,
): string {
  const includeContact = opts.includeContactInShortlist ?? true;

  const blocks = recommendations.map((r) => {
    const header: string[] = [];
    if (r.source === "home") {
      header.push(`# Partner ${r.partnerId} — ${r.name} (${r.city ?? "unknown"})   [home]`);
    } else {
      header.push(`# Partner ${r.partnerId} — ${r.name} (${r.city ?? "unknown"})   [nearby]`);
      header.push(
        `Borrowed from: ${r.sourceCity}, ~${formatDistance(r.distanceKm)} km from ${opts.requestedCity}`,
      );
      header.push(`Similarity score: ${formatSimilarity(r.similarity)}`);
    }

    const profile = includeContact ? r.llmProfile : stripContactLines(r.llmProfile);
    return `${header.join("\n")}\n\n${profile}`;
  });

  return blocks.join("\n\n---\n\n");
}

/** Re-exported for callers that only have a `PartnerLite[]` (e.g. tests). */
export type { PartnerLite };
