/**
 * lib/convex.ts — the Convex counterpart of the Supabase build's lib/supabase.ts.
 *
 * It exports ONE thing the rest of the pipeline depends on: `getConvex()`,
 * returning a typed façade over the deployment. Every Supabase call site in
 * lib/partners/ swapped `SupabaseClient` for `ConvexBackend` and kept its
 * surrounding logic byte-for-byte — that is what makes the A/B fair.
 *
 * ── WHY A FAÇADE INSTEAD OF PASSING ConvexHttpClient AROUND ──────────────────
 *
 * The Supabase code passed a `SupabaseClient` down as an injectable dependency
 * so the unit suite could run fully mocked with no network and no secrets. Same
 * requirement here — but mocking `ConvexHttpClient` means mocking a generic
 * `query(functionReference, args)`, which is untyped at the mock boundary and
 * easy to get silently wrong. Five named methods are mockable with a plain
 * object literal, and each one's signature documents exactly which Convex
 * function it calls.
 *
 * ── WHY makeFunctionReference AND NOT api FROM _generated ────────────────────
 *
 * `convex/_generated/` only exists after `npx convex dev`/`codegen` has run
 * against a real deployment. The unit suite must keep running in an
 * environment with no deployment and no secrets (`npm test` needs neither in
 * either build), and `npm run typecheck` must not require one either. Typed
 * `makeFunctionReference` calls give this module a compile-time contract
 * without a codegen dependency; the SERVER side of the same contract is
 * typechecked by `npx convex dev`, which validates convex/*.ts against the
 * generated types. The two are kept in sync by hand, and
 * scripts/verify-convex-setup.ts calls every one of them live, so a drift
 * shows up as a failed verification rather than a runtime surprise.
 *
 * ── ABORT SEMANTICS (a real, documented difference from Supabase) ────────────
 *
 * supabase-js `.abortSignal(s)` aborts the underlying fetch, so a timed-out
 * stage stops costing anything server-side. `ConvexHttpClient` takes no
 * per-call signal, so `withAbort` below rejects the caller's promise on
 * timeout while the Convex function runs to completion. This changes nothing
 * about MEASURED latency (the caller returns at the same moment either way);
 * it only means a timed-out Convex call still consumes its function-execution
 * budget. Recorded in MIGRATION-NOTES.md §"Known deviations".
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// ─── Row shapes (mirror the `returns` validators in convex/*.ts) ─────────────

/** Mirrors `convex/cities.ts:resolveCityFuzzy` — the resolve_city_fuzzy RPC. */
export interface ConvexResolvedCityRow {
  city: string;
  lat: number;
  lon: number;
  sim: number;
}

/** Mirrors `convex/cities.ts:cityCentroids` — the city_centroids() RPC. */
export interface ConvexCityCentroidRow {
  city: string;
  lat: number;
  lon: number;
  cnt: number;
}

/** Mirrors `convex/partners.ts:getPartnersByCity`. Column names are the
 *  Postgres ones so lib/partners/get-partners-by-city.ts maps rows unchanged. */
export interface ConvexPartnerRow {
  id: number;
  name: string;
  city: string | null;
  tags_norm: string[] | null;
  body_markdown: string | null;
  website_url: string | null;
  is_active: boolean;
  updated_at: string | null;
  quality_score: number | null;
}

/** Mirrors `convex/search.ts:matchPartners` — the match_partners RPC. */
export interface ConvexMatchPartnersRow {
  partner_id: number;
  title: string;
  city: string | null;
  tags: string[] | null;
  distance_km: number | null;
  similarity: number | null;
  fts_rank: number | null;
  name_sim: number | null;
  tag_overlap: number | null;
  rrf_score: number;
}

/** Mirrors `convex/partners.ts:getPartnerProfiles` — the get_partner_profiles RPC. */
export interface ConvexPartnerProfileRow {
  partner_id: number;
  title: string;
  city: string | null;
  street: string | null;
  postal_code: string | null;
  tags: string[] | null;
  courses_text: string | null;
  body_markdown: string | null;
  email: string | null;
  phone: string | null;
  website_url: string | null;
  llm_profile: string | null;
  profile_data: unknown;
}

/** Mirrors `convex/partners.ts:getPartnerEmbeddings` (R13 §4.1). */
export interface ConvexPartnerEmbeddingRow {
  id: number;
  embedding: number[];
}

export type MatchPartnersArgs = {
  queryEmbedding: number[] | null;
  queryText: string | null;
  filters: { city?: string; excludeIds?: number[]; tags?: string[] };
  matchCount: number;
}

export type GetPartnersByCityArgs = {
  aliases: string[];
  tagFilter?: string[];
  includeInactive?: boolean;
}

export interface CallOpts {
  signal?: AbortSignal;
}

/**
 * The complete set of backend operations the agent performs. Five methods,
 * one per Postgres RPC / query the Supabase build used. Anything not on this
 * interface is not on the request path.
 */
export interface ConvexBackend {
  resolveCityFuzzy(place: string, opts?: CallOpts): Promise<ConvexResolvedCityRow | null>;
  getPartnersByCity(
    args: GetPartnersByCityArgs,
    opts?: CallOpts,
  ): Promise<ConvexPartnerRow[]>;
  cityCentroids(opts?: CallOpts): Promise<ConvexCityCentroidRow[]>;
  matchPartners(
    args: MatchPartnersArgs,
    opts?: CallOpts,
  ): Promise<ConvexMatchPartnersRow[]>;
  getPartnerProfiles(
    ids: number[],
    opts?: CallOpts,
  ): Promise<ConvexPartnerProfileRow[]>;
  /**
   * SIXTH operation, added consciously for R13 §4.1 (home relevance scoring).
   * Point-reads on `partnerEmbeddings.by_source_id`; results are cached per
   * partner for 24h in lib/partners/get-partner-embeddings.ts, so this runs
   * at most once per city per day, not per ranking pass. Recorded in
   * MIGRATION-NOTES.md as the fifth data-layer file.
   */
  getPartnerEmbeddings(
    ids: number[],
    opts?: CallOpts,
  ): Promise<ConvexPartnerEmbeddingRow[]>;
}

// ─── Typed function references ───────────────────────────────────────────────

const refs = {
  resolveCityFuzzy: makeFunctionReference<
    "query",
    { place: string },
    ConvexResolvedCityRow | null
  >("cities:resolveCityFuzzy"),

  cityCentroids: makeFunctionReference<"query", Record<string, never>, ConvexCityCentroidRow[]>(
    "cities:cityCentroids",
  ),

  getPartnersByCity: makeFunctionReference<
    "query",
    GetPartnersByCityArgs,
    ConvexPartnerRow[]
  >("partners:getPartnersByCity"),

  getPartnerProfiles: makeFunctionReference<
    "query",
    { ids: number[] },
    ConvexPartnerProfileRow[]
  >("partners:getPartnerProfiles"),

  matchPartners: makeFunctionReference<"action", MatchPartnersArgs, ConvexMatchPartnersRow[]>(
    "search:matchPartners",
  ),

  getPartnerEmbeddings: makeFunctionReference<
    "query",
    { ids: number[] },
    ConvexPartnerEmbeddingRow[]
  >("partners:getPartnerEmbeddings"),
} as const;

// ─── Abort plumbing ──────────────────────────────────────────────────────────

/** Rejects as soon as `signal` aborts, so the per-stage timeouts in
 *  lib/partners/resolve-partners.ts behave identically to the Supabase build
 *  from the caller's point of view. See the header for what differs. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new Error("Convex request aborted before it started"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Convex request aborted (timeout)"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// ─── The client ──────────────────────────────────────────────────────────────

let cachedClient: ConvexHttpClient | undefined;
let cachedBackend: ConvexBackend | undefined;

/**
 * Lazily constructs (and caches) the singleton HTTP client from `CONVEX_URL`
 * (or `NEXT_PUBLIC_CONVEX_URL`, which is what `npx convex dev` writes into
 * .env.local by default).
 *
 * Throws a clear error naming the missing variable — never logs its value.
 * Same contract as getSupabase() in the Supabase build, including being
 * server-side only.
 */
function getClient(): ConvexHttpClient {
  if (cachedClient) return cachedClient;

  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "getConvex: missing required environment variable CONVEX_URL " +
        "(or NEXT_PUBLIC_CONVEX_URL). Run `npx convex dev` once to provision a " +
        "deployment — see SETUP.md.",
    );
  }

  cachedClient = new ConvexHttpClient(url);
  return cachedClient;
}

export function getConvex(): ConvexBackend {
  if (cachedBackend) return cachedBackend;

  // `async` on every method is deliberate: getClient() throws when CONVEX_URL
  // is unset, and a synchronous throw from a Promise-returning method is a
  // trap for callers that hold the promise before awaiting it (the gap-fill
  // fan-out does exactly that, via Promise.allSettled). Async turns it into a
  // rejection, which every caller already handles.
  cachedBackend = {
    resolveCityFuzzy: async (place, opts) =>
      withAbort(getClient().query(refs.resolveCityFuzzy, { place }), opts?.signal),

    getPartnersByCity: async (args, opts) =>
      withAbort(getClient().query(refs.getPartnersByCity, args), opts?.signal),

    cityCentroids: async (opts) =>
      withAbort(getClient().query(refs.cityCentroids, {}), opts?.signal),

    // An ACTION, not a query: `ctx.vectorSearch` is action-only in Convex.
    matchPartners: async (args, opts) =>
      withAbort(getClient().action(refs.matchPartners, args), opts?.signal),

    getPartnerProfiles: async (ids, opts) =>
      withAbort(getClient().query(refs.getPartnerProfiles, { ids }), opts?.signal),

    getPartnerEmbeddings: async (ids, opts) =>
      withAbort(getClient().query(refs.getPartnerEmbeddings, { ids }), opts?.signal),
  };

  return cachedBackend;
}

/** Test hook — drops the memoized client so a changed CONVEX_URL takes effect. */
export function resetConvexClient(): void {
  cachedClient = undefined;
  cachedBackend = undefined;
}
