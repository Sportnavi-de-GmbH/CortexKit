/**
 * Shared types for the partner-injection leaf tools. Ported from
 * eve-agent-plan/agent/tools/types.ts (design reference, read-only) and
 * adjusted to the REAL `public.partners` schema (verified live via the
 * Supabase MCP — see M3a report). PII is intentionally excluded from
 * `PartnerLite` — the type that is allowed to enter the LLM context.
 */

/**
 * A partner row as fetched server-side by the leaf tools. No PII: contact
 * info (email/phone) is never selected by these queries and never leaves
 * the DB layer here — per owner policy, contact info reaches the LLM
 * context ONLY inside `llm_profile` via build_recommendations
 * (get-partner-details.ts), never through this shape.
 */
export interface PartnerRow {
  id: number;
  name: string;
  city: string | null;
  /** Not selected by getPartnersByCity — nothing in the request path reads
   *  these. Optional so fixtures and any future query that does want them
   *  still typecheck. See the SELECT_COLUMNS comment in get-partners-by-city.ts. */
  postal_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tags_norm: string[] | null;
  /** Not selected — see `postal_code` above. */
  courses_text?: string | null;
  body_markdown: string | null;
  website_url: string | null;
  is_active: boolean;
  quality_score?: number | null; // from partner_intelligence (best-effort join)
  /** ISO timestamp; added for overflow_trim's "recency" strategy. Not PII. */
  updated_at?: string | null;
}

/** What is allowed to enter the LLM context. No PII (id/name/city/tags/summary/url only). */
export interface PartnerLite {
  id: number;
  name: string;
  city: string | null;
  tags: string[];
  /** FULL cleaned body_markdown — never truncated (context quality > tokens). */
  summary: string;
  website_url: string | null;
  source: "home" | "nearby";
  sourceCity: string;
  similarity?: number; // only for "nearby" gap-fill partners
  distanceKm?: number;
}

export interface ResolvedCity {
  input: string;
  canonical: string;
  aliases: string[];
  centroid: { lat: number; lng: number } | null;
  partnerCount: number;
  confidence: number;
}

export interface Intent {
  text: string; // free-text intent for hybrid search query_text
  tags: string[]; // optional tags_norm filters
}

export interface NearbyCity {
  city: string;
  centroid: { lat: number; lng: number };
  distanceKm: number;
  availableCount: number;
}

export interface SimilarityHit {
  id: number;
  name: string;
  city: string | null;
  tags_norm: string[] | null;
  body_markdown: string | null;
  website_url: string | null;
  similarity: number; // 0..1 (1 - cosine distance); null-embedding degrade → 0
}

export interface PartnerDetails {
  partnerId: number;
  name: string;
  city: string | null;
  /** Pre-rendered, fully labeled context block from partners.llm_profile. */
  llmProfile: string;
}

/** Per-stage/aggregate resolution metadata — the honest paper trail of a search. */
export interface ResolutionMeta {
  minRequired: number;
  maxAllowed: number;
  maxCities: number;
  totalReturned: number;
  minMet: boolean;
  cappedAtMax: boolean;
  citiesExhausted: boolean;
  warnings: string[];
  /** Wall-clock (ms) per named stage, via the injectable clock. */
  timingsMs: Record<string, number>;
}

/** The finished, deterministic output of resolve_partners (Steps 2-5). */
export interface ResolvedPartnerSet {
  requestedCity: ResolvedCity;
  home: PartnerLite[];
  filled: PartnerLite[];
  citiesUsed: string[];
  meta: ResolutionMeta;
}
