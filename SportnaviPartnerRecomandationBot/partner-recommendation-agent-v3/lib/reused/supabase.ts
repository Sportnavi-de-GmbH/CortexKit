// V2 COPY — copied from ../partner-recommendation-agent-supabase/lib/supabase.ts on 2026-09-14.
// V3 COPY — re-copied unchanged from ../partner-recommendation-agent-v2/lib/reused/supabase.ts on 2026-09-14.
// Copied (not imported) so V2 has no build-time dependency on the existing agent and the
// existing agent stays untouched. Re-diff against the source when that file changes.
//
// ONE DELIBERATE DIVERGENCE (2026-09-14, partner cards): `getPartnerProfiles` also fetches
// `partners.logo_url` (a plain select run concurrently with the RPC, best-effort) and merges
// it into each row as `logo_url`. The `get_partner_profiles` SQL function itself is shared
// with the live build and is NOT changed. Everything else is byte-identical to the source.

/**
 * lib/supabase.ts — the Supabase/Postgres data facade of this build.
 *
 * This build is the R13 Convex agent (../partner-recommendation-agent-convex,
 * the reference implementation) with its data layer pointed back at the
 * original Supabase project. It exports ONE thing the rest of the pipeline
 * depends on: `getSupabase()`, returning a typed facade over the database.
 * Every call site in lib/partners/ is the reference's code with
 * `ConvexBackend` renamed to `SupabaseBackend` — nothing else changed there,
 * which is what keeps the two builds diffable.
 *
 * ── WHY A FACADE INSTEAD OF PASSING SupabaseClient AROUND ────────────────────
 *
 * The retired Supabase build passed a raw `SupabaseClient` down and every
 * file composed its own PostgREST query, so the unit suite needed a Proxy
 * impersonating the chainable query builder. The reference replaced that
 * with a six-method interface that a plain object literal can fake. Keeping
 * the interface here means the reference's tests run unchanged against this
 * build, and every Supabase-specific detail (RPC names, snake_case argument
 * keys, the pgvector string encoding, the two-query intelligence join) lives
 * in exactly one file — this one.
 *
 * ── THE SIX OPERATIONS AND THEIR POSTGRES COUNTERPARTS ───────────────────────
 *
 *   resolveCityFuzzy     → rpc  resolve_city_fuzzy(place)          (limit 1, sim > 0.4 inside)
 *   getPartnersByCity    → from partners .in("city", aliases)      + best-effort partner_intelligence join
 *   cityCentroids        → rpc  city_centroids()                   (server-side GROUP BY)
 *   matchPartners        → rpc  match_partners(query_embedding, query_text, filters, match_count)
 *   getPartnerProfiles   → rpc  get_partner_profiles(p_ids)         ∥ from partners .select("id, logo_url") (V2, best-effort)
 *   getPartnerEmbeddings → from partners .select("id, profile_embedding") .in("id", ids)
 *
 * ── ABORT SEMANTICS ──────────────────────────────────────────────────────────
 *
 * supabase-js `.abortSignal(s)` aborts the underlying fetch, so a timed-out
 * stage stops costing anything server-side. This is a real (favourable)
 * difference from the Convex reference, whose HTTP client takes no per-call
 * signal. Recorded in PARITY-NOTES.md.
 *
 * ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
 *
 * `partners` has RLS enabled with NO policies, so this client MUST be built
 * with the SERVICE ROLE key: the anon key returns zero rows SILENTLY (E23).
 * Server-side only — never import this module from browser code.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { EMBEDDING_DIMENSIONS } from "./embeddings";

// ─── Row shapes (the exact columns the Postgres side returns) ────────────────

/** `resolve_city_fuzzy(place)` — one row or none. */
export interface SupabaseResolvedCityRow {
  city: string;
  lat: number;
  lon: number;
  sim: number;
}

/** `city_centroids()`. */
export interface SupabaseCityCentroidRow {
  city: string;
  lat: number;
  lon: number;
  cnt: number;
}

/** The `partners` projection getPartnersByCity selects, plus the joined
 *  `partner_intelligence.quality_score`. NO email/phone on this path: contact
 *  details reach the model only inside `llm_profile` (get_partner_profiles). */
export interface SupabasePartnerRow {
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

/** `match_partners(...)`. */
export interface SupabaseMatchPartnersRow {
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

/** `get_partner_profiles(p_ids)` — all thirteen columns, plus `logo_url`
 *  merged in by V2 from a concurrent `partners` select (see header). Unlike
 *  the Convex reference, `profile_data` is real here (the jsonb blob was never
 *  migrated to Convex). Nothing reads it in either build. */
export interface SupabasePartnerProfileRow {
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
  /** V2: `partners.logo_url` — NULL when the directory has no logo, or when the
   *  best-effort logo select failed. Consumers must handle null. */
  logo_url: string | null;
}

/** R13 §4.1 — `partners.profile_embedding`, decoded from pgvector's text form. */
export interface SupabasePartnerEmbeddingRow {
  id: number;
  embedding: number[];
}

export type MatchPartnersArgs = {
  queryEmbedding: number[] | null;
  queryText: string | null;
  filters: { city?: string; excludeIds?: number[]; tags?: string[] };
  matchCount: number;
};

export type GetPartnersByCityArgs = {
  aliases: string[];
  tagFilter?: string[];
  includeInactive?: boolean;
};

export interface CallOpts {
  signal?: AbortSignal;
}

/**
 * The complete set of backend operations the agent performs. Same six
 * methods, same signatures, same row shapes as the reference's
 * `ConvexBackend`. Anything not on this interface is not on the request path.
 */
export interface SupabaseBackend {
  resolveCityFuzzy(place: string, opts?: CallOpts): Promise<SupabaseResolvedCityRow | null>;
  getPartnersByCity(args: GetPartnersByCityArgs, opts?: CallOpts): Promise<SupabasePartnerRow[]>;
  cityCentroids(opts?: CallOpts): Promise<SupabaseCityCentroidRow[]>;
  matchPartners(args: MatchPartnersArgs, opts?: CallOpts): Promise<SupabaseMatchPartnersRow[]>;
  getPartnerProfiles(ids: number[], opts?: CallOpts): Promise<SupabasePartnerProfileRow[]>;
  /**
   * SIXTH operation (R13 §4.1, home relevance scoring). Results are cached
   * per partner for 24h in lib/partners/get-partner-embeddings.ts, so this
   * runs at most once per city per day, not per ranking pass.
   */
  getPartnerEmbeddings(ids: number[], opts?: CallOpts): Promise<SupabasePartnerEmbeddingRow[]>;
}

// ─── The projection getPartnersByCity selects ────────────────────────────────

/** Only what is read downstream. `updated_at` feeds overflow_trim's "recency"
 *  strategy; `courses_text`/coordinates were once selected here for every
 *  partner in a city and read by nothing. */
export const PARTNER_SELECT_COLUMNS =
  "id, name, city, tags_norm, body_markdown, website_url, is_active, updated_at";

// ─── pgvector decoding ───────────────────────────────────────────────────────

/**
 * pgvector comes back over PostgREST as the string "[0.1,0.2,…]" (or, with a
 * newer client/schema cache, already as a number[]). Both are accepted; a
 * vector of the wrong dimensionality is refused loudly, because mixing
 * embedding spaces corrupts similarity SILENTLY (E12).
 */
export function decodeVector(raw: unknown, partnerId: number): number[] {
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "number")) {
    throw new Error(
      `getPartnerEmbeddings: partner ${partnerId} has a non-numeric profile_embedding`,
    );
  }
  if (parsed.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `getPartnerEmbeddings: partner ${partnerId} has a ${parsed.length}-dim embedding, ` +
        `expected ${EMBEDDING_DIMENSIONS}. Refusing to score against a mixed embedding space (E12).`,
    );
  }
  return parsed as number[];
}

// ─── The adapter ─────────────────────────────────────────────────────────────

/**
 * Builds the six-method facade over a concrete client. Exported so the
 * adapter itself can be unit-tested against a stubbed client
 * (tests/supabase-backend.test.ts); production code goes through
 * `getSupabase()` below.
 */
export function createSupabaseBackend(client: SupabaseClient): SupabaseBackend {
  return {
    async resolveCityFuzzy(place, opts) {
      let q = client.rpc("resolve_city_fuzzy", { place });
      if (opts?.signal) q = q.abortSignal(opts.signal);
      const { data, error } = await q;
      if (error) throw new Error(`resolve_city_fuzzy RPC failed: ${error.message}`);
      const rows = (data ?? []) as SupabaseResolvedCityRow[];
      return rows[0] ?? null; // the RPC already applies `limit 1`
    },

    async getPartnersByCity(args, opts) {
      if (args.aliases.length === 0) return []; // no coverage (E2)

      let q = client.from("partners").select(PARTNER_SELECT_COLUMNS).in("city", args.aliases);
      if (!args.includeInactive) q = q.eq("is_active", true);
      if (args.tagFilter && args.tagFilter.length > 0) q = q.overlaps("tags_norm", args.tagFilter);
      if (opts?.signal) q = q.abortSignal(opts.signal);

      const { data, error } = await q;
      if (error) throw new Error(`partners query failed: ${error.message}`);

      // Dedup by id: aliases can overlap, or a partner can match twice.
      const byId = new Map<number, SupabasePartnerRow>();
      for (const raw of (data ?? []) as unknown as Array<Omit<SupabasePartnerRow, "quality_score">>) {
        if (byId.has(raw.id)) continue;
        byId.set(raw.id, { ...raw, quality_score: null });
      }
      const rows = [...byId.values()];
      if (rows.length === 0) return rows;

      // Best-effort manual join — there is no FK between the two tables, so
      // PostgREST embedding is unavailable (verified live). quality_score is a
      // nice-to-have that the "quality" overflow strategy reads; never block
      // the fetch on it.
      let intel = client
        .from("partner_intelligence")
        .select("partner_id, quality_score")
        .in("partner_id", rows.map((r) => r.id));
      if (opts?.signal) intel = intel.abortSignal(opts.signal);
      const { data: intelRows, error: intelError } = await intel;
      if (intelError) return rows;

      const qualityById = new Map<number, number | null>();
      for (const r of (intelRows ?? []) as Array<{ partner_id: number; quality_score: number | null }>) {
        qualityById.set(r.partner_id, r.quality_score);
      }
      for (const r of rows) r.quality_score = qualityById.get(r.id) ?? null;
      return rows;
    },

    async cityCentroids(opts) {
      let q = client.rpc("city_centroids");
      if (opts?.signal) q = q.abortSignal(opts.signal);
      const { data, error } = await q;
      if (error) throw new Error(`city_centroids RPC failed: ${error.message}`);
      return (data ?? []) as SupabaseCityCentroidRow[];
    },

    async matchPartners(args, opts) {
      // The ONLY place camelCase becomes the RPC's snake_case. `tags` MUST be
      // passed whenever present: the qtags CTE reads filters->'tags', and the
      // tg ranking branch is guarded by a non-empty slug set (CLAUDE.md §10.10).
      const filters: Record<string, unknown> = {};
      if (args.filters.city !== undefined) filters.city = args.filters.city;
      if (args.filters.tags !== undefined) filters.tags = args.filters.tags;
      if (args.filters.excludeIds !== undefined) filters.exclude_ids = args.filters.excludeIds;

      let q = client.rpc("match_partners", {
        query_embedding: args.queryEmbedding,
        query_text: args.queryText,
        filters,
        match_count: args.matchCount,
      });
      if (opts?.signal) q = q.abortSignal(opts.signal);
      const { data, error } = await q;
      if (error) throw new Error(`match_partners RPC failed: ${error.message}`);
      return (data ?? []) as SupabaseMatchPartnersRow[];
    },

    async getPartnerProfiles(ids, opts) {
      if (ids.length === 0) return [];
      let q = client.rpc("get_partner_profiles", { p_ids: ids });
      if (opts?.signal) q = q.abortSignal(opts.signal);

      // V2: the logo is presentation metadata the shared RPC does not return.
      // Fetch it with a tiny indexed select IN PARALLEL with the RPC (no added
      // wall clock) and merge it in. Best-effort, like the intelligence join in
      // getPartnersByCity: a logo failure must never cost the profiles.
      let logoQ = client.from("partners").select("id, logo_url").in("id", ids);
      if (opts?.signal) logoQ = logoQ.abortSignal(opts.signal);
      const logoPromise = Promise.resolve(logoQ).then(
        ({ data: logoRows, error: logoError }) => {
          if (logoError) {
            console.warn(`[supabase] partner logo select failed (profiles unaffected): ${logoError.message}`);
            return new Map<number, string | null>();
          }
          return new Map<number, string | null>(
            ((logoRows ?? []) as unknown as Array<{ id: number; logo_url: string | null }>).map((r) => [r.id, r.logo_url ?? null]),
          );
        },
        (err: unknown) => {
          console.warn(`[supabase] partner logo select failed (profiles unaffected): ${err instanceof Error ? err.message : String(err)}`);
          return new Map<number, string | null>();
        },
      );

      const { data, error } = await q;
      if (error) {
        await logoPromise.catch(() => undefined);
        throw new Error(`get_partner_profiles RPC failed: ${error.message}`);
      }
      const logos = await logoPromise;
      return ((data ?? []) as Array<Omit<SupabasePartnerProfileRow, "logo_url">>).map((row) => ({
        ...row,
        logo_url: logos.get(row.partner_id) ?? null,
      }));
    },

    async getPartnerEmbeddings(ids, opts) {
      if (ids.length === 0) return [];
      let q = client
        .from("partners")
        .select("id, profile_embedding")
        .in("id", ids)
        .not("profile_embedding", "is", null);
      if (opts?.signal) q = q.abortSignal(opts.signal);
      const { data, error } = await q;
      if (error) throw new Error(`partners embedding query failed: ${error.message}`);

      const out: SupabasePartnerEmbeddingRow[] = [];
      for (const raw of (data ?? []) as unknown as Array<{ id: number; profile_embedding: unknown }>) {
        out.push({ id: raw.id, embedding: decodeVector(raw.profile_embedding, raw.id) });
      }
      return out;
    },
  };
}

// ─── The singleton ───────────────────────────────────────────────────────────

let cachedClient: SupabaseClient | undefined;
let cachedBackend: SupabaseBackend | undefined;

/**
 * Lazily constructs (and caches) the singleton client from
 * `MEMORY_SUPABASE_URL` / `MEMORY_SUPABASE_SERVICE_ROLE_KEY`.
 *
 * Throws a clear error naming the missing variable(s) — never logs the
 * values. Same contract as the reference's getClient(), including being
 * server-side only.
 */
function getClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.MEMORY_SUPABASE_URL;
  const serviceRoleKey = process.env.MEMORY_SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("MEMORY_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("MEMORY_SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0 || !url || !serviceRoleKey) {
    throw new Error(
      `getSupabase: missing required environment variable(s): ${missing.join(", ")}. ` +
        "See .env.local.example — the SERVICE ROLE key is mandatory (RLS with no policies).",
    );
  }

  cachedClient = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  return cachedClient;
}

export function getSupabase(): SupabaseBackend {
  if (cachedBackend) return cachedBackend;

  // Every method is `async` and resolves the client INSIDE the call: a
  // missing env var must surface as a rejection, not a synchronous throw —
  // the gap-fill fan-out holds promises before awaiting them
  // (Promise.allSettled), and a synchronous throw there is a trap.
  const lazy = (): SupabaseBackend => createSupabaseBackend(getClient());
  cachedBackend = {
    resolveCityFuzzy: async (place, opts) => lazy().resolveCityFuzzy(place, opts),
    getPartnersByCity: async (args, opts) => lazy().getPartnersByCity(args, opts),
    cityCentroids: async (opts) => lazy().cityCentroids(opts),
    matchPartners: async (args, opts) => lazy().matchPartners(args, opts),
    getPartnerProfiles: async (ids, opts) => lazy().getPartnerProfiles(ids, opts),
    getPartnerEmbeddings: async (ids, opts) => lazy().getPartnerEmbeddings(ids, opts),
  };
  return cachedBackend;
}

/** Test hook — drops the memoized client so changed env vars take effect. */
export function resetSupabaseClient(): void {
  cachedClient = undefined;
  cachedBackend = undefined;
}
