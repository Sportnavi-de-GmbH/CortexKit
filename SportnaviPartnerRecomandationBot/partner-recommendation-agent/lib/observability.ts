/**
 * lib/observability.ts
 *
 * M9 — structured resolution event. One JSON line per resolve_partners call,
 * per eve-agent-plan/docs/07-observability-and-production.md §3
 * ("Observability (what to log)"). This is the metrics source for the
 * gap-fill rate / minMet rate / cities-exhausted rate dashboards described
 * there — see that doc for the dashboard list.
 *
 * Hard rules (per docs/07 §1 "Security & privacy" and §3):
 *  - NO PII (email/phone never even reach this layer — ResolvedPartnerSet's
 *    PartnerLite type has no PII fields to begin with).
 *  - NO partner names or ids — only counts.
 *  - NO free-text user input (the request text / intent is never logged).
 *  - `requestedCity` is logged as the CANONICAL resolved name only, never the
 *    raw user-typed city string.
 *  - Warnings are logged as coarse classification codes (`warningCodes`),
 *    never as the raw free-text warning strings (which are internal
 *    diagnostics, e.g. "Search failed for \"X\"; skipped (<db error>)" —
 *    fine for `meta.warnings` returned to the caller, not fine for a log
 *    sink that dashboards and third parties may read).
 */

import type { ResolvedPartnerSet } from "./partners/types";

export interface ResolutionEventExtra {
  /** Correlates this event with the tool call that produced it. */
  requestId: string;
}

/** Coarse, PII-free classification of the free-text warnings resolvePartners
 * produces (see lib/partners/resolve-partners.ts). Matches the edge-case
 * catalogue in eve-agent-plan/docs/05-edge-cases.md by pattern, not by
 * carrying the original message. Exported so lib/partners/render-context.ts
 * can reuse the same classification to render user-safe (never raw) warning
 * summaries for the model — see that file's renderMetaSummary. */
export function classifyWarning(warning: string): string {
  if (/clamp/i.test(warning)) return "config_min_clamped_to_max"; // E10
  if (/trimmed to/i.test(warning)) return "home_overflow_trimmed"; // E14
  if (/nearby-city lookup failed/i.test(warning)) return "nearby_city_lookup_failed"; // E24
  if (/search failed for/i.test(warning)) return "city_search_failed"; // E24
  if (/rejected below similarity floor/i.test(warning)) return "similarity_floor_rejects"; // E9
  if (/partner\(s\) found near/i.test(warning)) return "shortfall_below_min"; // E13
  if (/omitted for missing profile content/i.test(warning)) return "profile_content_missing";
  if (/hydration returned/i.test(warning)) return "hydration_incomplete";
  if (/hydration failed/i.test(warning)) return "hydration_failed";
  if (/embedding/i.test(warning)) return "embedding_degraded"; // E25
  return "other";
}

/**
 * Emits ONE structured JSON line to stdout describing a partner resolution.
 * Fire-and-forget: NEVER throws, even if `set` is malformed — a broken
 * observability call must never take down the request it is observing.
 */
export function emitResolutionEvent(set: ResolvedPartnerSet, extra: ResolutionEventExtra): void {
  try {
    const meta = set.meta;
    const warnings = meta.warnings ?? [];
    const gap = Math.max(0, (meta.minRequired ?? 0) - (set.home?.length ?? 0));

    const event = {
      requestId: extra.requestId,
      requestedCity: set.requestedCity?.canonical ?? null,
      homeCount: set.home?.length ?? 0,
      filledCount: set.filled?.length ?? 0,
      citiesUsed: set.citiesUsed ?? [],
      gap,
      minMet: meta.minMet ?? false,
      cappedAtMax: meta.cappedAtMax ?? false,
      citiesExhausted: meta.citiesExhausted ?? false,
      warningsCount: warnings.length,
      warningCodes: [...new Set(warnings.map(classifyWarning))],
      timingsMs: meta.timingsMs ?? {},
    };

    // Deferred off the request path. This is documented as fire-and-forget,
    // but JSON.stringify + console.log ran INLINE, so every search paid for a
    // diagnostic before it could return. queueMicrotask keeps the ordering
    // and the never-throws contract while getting it out of the hot path.
    queueMicrotask(() => {
      try {
        console.log(JSON.stringify(event));
      } catch {
        // Observability must never throw — swallow and move on.
      }
    });
  } catch {
    // Observability must never throw — swallow and move on.
  }
}
