/**
 * Shared test fakes for lib/partners/* unit tests. Not a *.test.ts file, so
 * vitest's `tests/**\/*.test.ts` include pattern skips it.
 *
 * CONVEX PORT of the Supabase build's `fakeSupabase`. That fake had to be a
 * Proxy impersonating PostgREST's chainable `PostgrestFilterBuilder`, because
 * the production code spoke query-builder. The Convex data layer speaks a
 * five-method interface (`ConvexBackend`, lib/convex.ts), so the fake is a
 * plain object — which is the point of that interface existing.
 *
 * Every call is recorded in `calls` with its arguments AND the AbortSignal it
 * was given, so the timeout assertions the Supabase suite made against
 * `.abortSignal()` have a direct equivalent here.
 */
import { vi } from "vitest";

import type {
  CallOpts,
  ConvexBackend,
  ConvexCityCentroidRow,
  ConvexMatchPartnersRow,
  ConvexPartnerProfileRow,
  ConvexPartnerEmbeddingRow,
  ConvexPartnerRow,
  ConvexResolvedCityRow,
  GetPartnersByCityArgs,
  MatchPartnersArgs,
} from "../../lib/convex";

export interface RecordedCall {
  fn: keyof ConvexBackend;
  args: unknown;
  signal: AbortSignal | undefined;
}

export interface FakeConvex extends ConvexBackend {
  /** Every backend call, in order. */
  calls: RecordedCall[];
  /** Calls to one function, in order. */
  callsTo(fn: keyof ConvexBackend): RecordedCall[];
}

/** A canned result, or a function of the call arguments (so a test can vary
 *  the answer per city), or a rejection. */
type Canned<Args, Result> = Result | ((args: Args) => Result | Promise<Result>) | Error;

export interface FakeConvexOptions {
  resolveCityFuzzy?: Canned<string, ConvexResolvedCityRow | null>;
  getPartnersByCity?: Canned<GetPartnersByCityArgs, ConvexPartnerRow[]>;
  cityCentroids?: Canned<void, ConvexCityCentroidRow[]>;
  matchPartners?: Canned<MatchPartnersArgs, ConvexMatchPartnersRow[]>;
  getPartnerProfiles?: Canned<number[], ConvexPartnerProfileRow[]>;
  getPartnerEmbeddings?: Canned<number[], ConvexPartnerEmbeddingRow[]>;
}

async function resolveCanned<Args, Result>(
  canned: Canned<Args, Result> | undefined,
  fallback: Result,
  args: Args,
): Promise<Result> {
  if (canned === undefined) return fallback;
  if (canned instanceof Error) throw canned;
  if (typeof canned === "function") {
    return await (canned as (a: Args) => Result | Promise<Result>)(args);
  }
  return canned;
}

export function fakeConvex(opts: FakeConvexOptions = {}): FakeConvex {
  const calls: RecordedCall[] = [];

  const record = <Args>(fn: keyof ConvexBackend, args: Args, o?: CallOpts) => {
    calls.push({ fn, args, signal: o?.signal });
  };

  const backend: FakeConvex = {
    calls,
    callsTo: (fn) => calls.filter((c) => c.fn === fn),

    resolveCityFuzzy: vi.fn(async (place: string, o?: CallOpts) => {
      record("resolveCityFuzzy", place, o);
      return resolveCanned(opts.resolveCityFuzzy, null, place);
    }),

    getPartnersByCity: vi.fn(async (args: GetPartnersByCityArgs, o?: CallOpts) => {
      record("getPartnersByCity", args, o);
      return resolveCanned(opts.getPartnersByCity, [], args);
    }),

    cityCentroids: vi.fn(async (o?: CallOpts) => {
      record("cityCentroids", undefined, o);
      return resolveCanned(opts.cityCentroids, [], undefined as void);
    }),

    matchPartners: vi.fn(async (args: MatchPartnersArgs, o?: CallOpts) => {
      record("matchPartners", args, o);
      return resolveCanned(opts.matchPartners, [], args);
    }),

    getPartnerProfiles: vi.fn(async (ids: number[], o?: CallOpts) => {
      record("getPartnerProfiles", ids, o);
      return resolveCanned(opts.getPartnerProfiles, [], ids);
    }),

    getPartnerEmbeddings: vi.fn(async (ids: number[], o?: CallOpts) => {
      record("getPartnerEmbeddings", ids, o);
      return resolveCanned(opts.getPartnerEmbeddings, [], ids);
    }),
  };

  return backend;
}

/** A complete `getPartnerProfiles` row from the four fields callers read. */
export function profileRow(
  partial: Pick<ConvexPartnerProfileRow, "partner_id" | "title"> &
    Partial<ConvexPartnerProfileRow>,
): ConvexPartnerProfileRow {
  return {
    city: null,
    street: null,
    postal_code: null,
    tags: null,
    courses_text: null,
    body_markdown: null,
    email: null,
    phone: null,
    website_url: null,
    llm_profile: null,
    profile_data: null,
    ...partial,
  };
}

/** A complete `matchPartners` row from the fields a test cares about. */
export function matchRow(
  partial: Pick<ConvexMatchPartnersRow, "partner_id" | "title"> &
    Partial<ConvexMatchPartnersRow>,
): ConvexMatchPartnersRow {
  return {
    city: null,
    tags: null,
    distance_km: null,
    similarity: null,
    fts_rank: null,
    name_sim: null,
    tag_overlap: null,
    rrf_score: 0,
    ...partial,
  };
}

/** A complete `getPartnersByCity` row. */
export function partnerRow(
  partial: Pick<ConvexPartnerRow, "id" | "name"> & Partial<ConvexPartnerRow>,
): ConvexPartnerRow {
  return {
    city: null,
    tags_norm: null,
    body_markdown: null,
    website_url: null,
    is_active: true,
    updated_at: null,
    quality_score: null,
    ...partial,
  };
}
