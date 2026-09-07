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
  /**
   * Gap-fill target, counted in QUALIFIED partners (R13 §4.4): partners that
   * match the request's tags (when tags were supplied) or clear the relative
   * relevance cutoff (when they weren't). A full-looking city with nothing
   * relevant IS a coverage gap — Kampfsport in a 56-partner city with 3
   * Kampfsport partners borrows relevant partners from nearby. When relevance
   * scoring is unavailable (embedding down), this degrades to the historical
   * raw-count semantics.
   */
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
  // ── Relevance shortlist dials (R13 §4.2) ──────────────────────────────────
  /** Floor for the presented shortlist: below this, show top-N with a
   *  fit-mismatch disclosure rather than an empty/dead-end answer. */
  shortlistMin: number;
  /** ρ in the relative cutoff `top − ρ·(top − median)`; scale-free. */
  relevanceBand: number;
  /** Minimum consecutive score drop that counts as a knee when snapping the
   *  cutoff boundary (see score-relevance.ts). */
  minKneeGap: number;
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
 * Defaults tuned for the REAL table (2,333 partners across Germany → small
 * cities). The spec's "100" example is illustrative; measure the distribution
 * (docs/04 §5) before raising minPartners.
 */
export const DEFAULT_CONFIG: PartnerInjectionConfig = {
  // R13 DEFAULTS (2026-08-20, owner-approved design — plans/R13 §4.5).
  //
  // `minPartners` is the gap-fill TARGET counted in QUALIFIED partners (see
  // the interface doc above). The 2026-08-01 wide-context test profile
  // (100/100/10/100) is preserved as PRESETS.WIDE_CONTEXT_TEST below — its
  // purpose (making cross-city injection observable) is now served by
  // relevance gaps: a city with many partners but few *relevant* ones
  // gap-fills on its own.
  minPartners: 12,
  maxPartners: 100,
  // Gaps are ≤ 12 now; 10 concurrent city fan-outs are latency without yield.
  maxCities: 6,
  // Re-scoped as the hard PRESENTATION cap (shortlistMax): the most full
  // Tier-2 profiles one search may render. The model can pass a lower value;
  // the request budget can shrink the effective K further. R13 §4.5.
  finalRecommendations: 24,

  // Demoted (R13 §4.4): no longer the selection mechanism — the relative
  // relevance cutoff is. Survives only as an absolute sanity floor on
  // BORROWED partners; home partners are never floor-checked.
  similarityThreshold: 0.15,
  maxDistanceKm: 150, // 60 km reaches too few partner cities around small towns
  cityConfidenceMin: 0.6,
  ambiguityPolicy: "ask",
  overflowStrategy: "quality",
  // Sized to gap ≤ 12 so per-city k = gap + headroom ≤ 20 stays under
  // match_partners' hardcoded vector-branch `limit 40` (§10.2).
  dedupHeadroom: 8,
  requireTagMatch: false,
  includeInactive: false,
  neighborsCacheTtlSec: 86_400,
  embeddingModel: "openai/text-embedding-3-small", // 1536-dim; must match DB
  shortlistMin: 3,
  relevanceBand: 0.5,
  minKneeGap: 0.02,
  includeContactInShortlist: true,
};

/** Preset profiles — see docs/04 §4. */
export const PRESETS = {
  /**
   * The 2026-08-01 wide-context experiment (formerly DEFAULT_CONFIG). Kept as
   * an explicit preset per CLAUDE.md §7 — the experiment is not silently
   * reverted, it is opted into. Only meaningful on a large-window deployment:
   * 100 full profiles ≈ 42k tokens per search.
   */
  WIDE_CONTEXT_TEST: {
    ...DEFAULT_CONFIG,
    minPartners: 100,
    maxPartners: 100,
    maxCities: 10,
    finalRecommendations: 100,
    dedupHeadroom: 20,
  },
  /**
   * The narrow defaults in force until 2026-08-01. With relevance-driven gap
   * semantics (R13) the current DEFAULT_CONFIG is effectively this baseline
   * plus the shortlist dials.
   */
  PRODUCTION_BASELINE: {
    ...DEFAULT_CONFIG,
    minPartners: 12,
    maxPartners: 100,
    maxCities: 4,
    finalRecommendations: 100,
    similarityThreshold: 0.35,
    maxDistanceKm: 60,
    dedupHeadroom: 5,
  },
  LOCAL_FIRST: {
    ...DEFAULT_CONFIG,
    minPartners: 20,
    maxPartners: 500,
    maxCities: 10,
    similarityThreshold: 0.45,
    maxDistanceKm: 400,
  },
  WIDE_NET: {
    ...DEFAULT_CONFIG,
    minPartners: 20,
    maxPartners: 60,
    maxCities: 6,
    finalRecommendations: 50,
    similarityThreshold: 0.3,
    maxDistanceKm: 120,
  },
  /** maxCities: 1 disables gap-fill entirely. */
  STRICT_CITY: {
    ...DEFAULT_CONFIG,
    minPartners: 1,
    maxCities: 1,
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
  if (cfg.shortlistMin < 1) throw new Error("shortlistMin must be >= 1");
  if (cfg.relevanceBand < 0 || cfg.relevanceBand > 1)
    throw new Error("relevanceBand must be within 0..1");
  if (cfg.minKneeGap < 0) throw new Error("minKneeGap must be >= 0");
  let minPartners = cfg.minPartners;
  if (minPartners > cfg.maxPartners) {
    warnings.push(
      `minPartners (${minPartners}) > maxPartners (${cfg.maxPartners}); clamping minPartners to ${cfg.maxPartners}.`,
    );
    minPartners = cfg.maxPartners;
  }
  // match_partners' vector branch is hardcoded to `limit 40` (§10.2): a
  // per-city candidate pool larger than that is silently truncated. Warn
  // loudly (never silently) until R09 parameterizes the RPC limit.
  if (minPartners + cfg.dedupHeadroom > 40) {
    warnings.push(
      `minPartners (${minPartners}) + dedupHeadroom (${cfg.dedupHeadroom}) exceeds the ` +
        "match_partners vector-branch cap of 40 rows; per-city candidate pools will be truncated (see plans/R09).",
    );
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
