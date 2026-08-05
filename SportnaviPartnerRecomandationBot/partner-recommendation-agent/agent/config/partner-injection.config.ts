/**
 * Partner Injection — typed configuration (the single source of truth).
 *
 * These are the "four dials" from the spec plus advanced knobs. Nothing in the
 * tools hard-codes these numbers; everything imports from here.
 *
 * Ported from eve-agent-plan/agent/config/partner-injection.config.ts (design
 * reference, read-only). See docs/04-configuration.md there for meaning, safe
 * ranges, and how to choose defaults from the real city distribution.
 */

export type AmbiguityPolicy = "ask" | "proceed-and-disclose";

export type OverflowStrategy =
  | "quality" // order home by partner_intelligence.quality_score (default)
  | "similarity-overflow" // opt-in: rank home by relevance to intent
  | "recency" // most recently updated first
  | "random-stable"; // deterministic seeded shuffle

export interface PartnerInjectionConfig {
  // ── The four primary dials ────────────────────────────────────────────────
  /** Smallest acceptable number of partners before context is "good enough". */
  minPartners: number;
  /** Hard ceiling of partners injected into the AI context. */
  maxPartners: number;
  /** Max number of cities (home + nearby) to draw from. */
  maxCities: number;
  /** How many partners the user ultimately sees. */
  finalRecommendations: number;

  // ── Advanced knobs (safe defaults; see docs/04) ───────────────────────────
  /** Min cosine similarity (0..1) for a gap-fill partner to be accepted. */
  similarityThreshold: number;
  /** Don't borrow from cities farther than this (km) from the home city. null = off. */
  maxDistanceKm: number | null;
  /** Below this resolve_city_fuzzy confidence, treat the city as ambiguous. */
  cityConfidenceMin: number;
  /** What to do on a low-confidence city. */
  ambiguityPolicy: AmbiguityPolicy;
  /** How to trim a home city that alone exceeds maxPartners. */
  overflowStrategy: OverflowStrategy;
  /** Extra candidates fetched per city to survive dedup/threshold filtering. */
  dedupHeadroom: number;
  /** If intent tags are detected, filter home & nearby by tags_norm. */
  requireTagMatch: boolean;
  /** Include is_active = false partners (keep false in production). */
  includeInactive: boolean;
  /** Cache TTL (seconds) for the city-centroid / neighbor computation. */
  neighborsCacheTtlSec: number;
  /**
   * Embedding model — MUST match partners.embedding_model. Cross-referenced
   * with `EMBEDDING_MODEL` in lib/embeddings.ts (pinned to
   * "text-embedding-3-small", 1536-dim); this string carries the provider
   * prefix used in the database column.
   */
  embeddingModel: string;
  /**
   * Whether Tier-2 shortlist profiles keep their labeled contact header lines
   * (`Adresse:`, `Telefon:`, `E-Mail:`, `Social Media:`, `Google Maps:` — see
   * lib/partners/render-context.ts `stripContactLines`).
   *
   * ⚠️ KEEP THIS `true`. Partner contact details are public directory
   * information the partner published in order to be contacted, and
   * instructions.md rule #6 requires Navio to include them with every
   * recommendation — getting the user to the studio door is the product.
   * Setting this to `false` deletes the only structured source Navio has for
   * that, leaving it able to name a partner it cannot tell you how to reach.
   * It is a rendering switch, never a privacy control: contact mentions inside
   * free-text profile prose (e.g. a "## Kontakt & Anfahrt" section) survive
   * either way, so `false` degrades the answer without withholding anything.
   *
   * There is no `stripPII` knob here — email/phone are never selected into
   * `PartnerLite` (see lib/partners/types.ts), so contact data has exactly one
   * route into context: the pre-rendered `llm_profile`. Dedup is likewise not
   * configurable — the only implementation is by-id (`dedupeById`).
   */
  includeContactInShortlist: boolean;
}

/**
 * Production-ready defaults (2026-08-04, updated 2026-08-04).
 * Tuned for quality and reliability with expanded gap-fill.
 * Goal: give the model ~40 partners in context to choose from,
 * then curate and show only 5 high-quality recommendations to the user.
 * This balances context breadth with reasonable token costs.
 */
export const DEFAULT_CONFIG: PartnerInjectionConfig = {
  // Gap-fill target: fetch up to 40 partners to provide broad context for
  // quality curation. The model receives all 40 in context to make the best
  // 5 selections. This ensures good variety even in cities with sparse coverage,
  // while keeping the final recommendations focused and manageable.
  // Relaxed thresholds to reach closer to 40 in real-world data (Berlin test: 23→goal 35+).
  minPartners: 40,
  maxPartners: 40,
  maxCities: 8,
  finalRecommendations: 5,

  similarityThreshold: 0.2,  // lowered from 0.3: accept more gap-fill candidates
  maxDistanceKm: 120,        // increased from 80: reach more nearby cities
  cityConfidenceMin: 0.6,
  ambiguityPolicy: "ask",
  overflowStrategy: "quality",
  dedupHeadroom: 20,         // increased from 10: fetch more candidates per city
  requireTagMatch: false,
  includeInactive: false,
  neighborsCacheTtlSec: 86_400,
  embeddingModel: "openai/text-embedding-3-small", // 1536-dim; must match DB
  includeContactInShortlist: true,
};

/** Preset profiles — experimental configurations for A/B testing. */
export const PRESETS = {
  /**
   * Current production default: 40 in context, show 5.
   * Expanded gap-fill with relaxed thresholds to reach real-world availability.
   */
  PRODUCTION: {
    ...DEFAULT_CONFIG,
  },
  /**
   * Even more aggressive gap-fill: 60 in context, show 5.
   * For maximum choice and broader geographic reach.
   */
  WIDE_CONTEXT: {
    ...DEFAULT_CONFIG,
    minPartners: 60,
    maxPartners: 60,
    maxCities: 10,
    similarityThreshold: 0.15,
    maxDistanceKm: 150,
    dedupHeadroom: 30,
  },
  /**
   * Balanced conservative: 30 in context, show 5.
   * For quality-focused curation with decent variety.
   */
  BALANCED: {
    ...DEFAULT_CONFIG,
    minPartners: 30,
    maxPartners: 30,
    maxCities: 6,
    similarityThreshold: 0.25,
    maxDistanceKm: 100,
    dedupHeadroom: 15,
  },
  /**
   * Strict home-city only: no gap-fill, no nearby borrowing.
   * Use for testing or specific use cases.
   */
  STRICT_CITY: {
    ...DEFAULT_CONFIG,
    minPartners: 5,
    maxPartners: 5,
    maxCities: 1,
    finalRecommendations: 5,
  },
} satisfies Record<string, PartnerInjectionConfig>;

/**
 * Validate + normalize a config. Fails fast on nonsense; clamps the one case the
 * spec cares about (min > max) rather than crashing. See docs/03 Step 0.
 */
export function validateConfig(cfg: PartnerInjectionConfig): {
  cfg: PartnerInjectionConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (cfg.minPartners < 1) throw new Error("minPartners must be >= 1");
  if (cfg.maxCities < 1) throw new Error("maxCities must be >= 1");
  if (cfg.finalRecommendations < 1)
    throw new Error("finalRecommendations must be >= 1");
  if (cfg.similarityThreshold < 0 || cfg.similarityThreshold > 1)
    throw new Error("similarityThreshold must be within 0..1");
  if (cfg.maxDistanceKm !== null && cfg.maxDistanceKm <= 0)
    throw new Error("maxDistanceKm must be > 0 or null");

  let minPartners = cfg.minPartners;
  if (minPartners > cfg.maxPartners) {
    warnings.push(
      `minPartners (${minPartners}) > maxPartners (${cfg.maxPartners}); clamping minPartners to ${cfg.maxPartners}.`,
    );
    minPartners = cfg.maxPartners;
  }
  return { cfg: { ...cfg, minPartners }, warnings };
}

/**
 * Merges `overrides` over {@link DEFAULT_CONFIG} and re-validates the result
 * (throwing on the same hard-error rules as {@link validateConfig}, clamping
 * on the same min>max case).
 */
export function mergeConfig(overrides?: Partial<PartnerInjectionConfig>): {
  config: PartnerInjectionConfig;
  warnings: string[];
} {
  const merged: PartnerInjectionConfig = { ...DEFAULT_CONFIG, ...overrides };
  const { cfg, warnings } = validateConfig(merged);
  return { config: cfg, warnings };
}
