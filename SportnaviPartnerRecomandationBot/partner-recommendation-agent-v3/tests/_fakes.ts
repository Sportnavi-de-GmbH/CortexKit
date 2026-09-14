// V3: fakes ported from ../partner-recommendation-agent-v2/tests/_fakes.ts (cardOf removed) + workflow fakes
/**
 * Shared test fakes. The pipeline talks to the directory through the
 * six-method `SupabaseBackend` facade, so a plain object with canned answers
 * is a complete fake — no network, no Proxy, no query builder.
 */
import type {
  CallOpts,
  GetPartnersByCityArgs,
  MatchPartnersArgs,
  SupabaseBackend,
  SupabaseCityCentroidRow,
  SupabaseMatchPartnersRow,
  SupabasePartnerEmbeddingRow,
  SupabasePartnerProfileRow,
  SupabasePartnerRow,
  SupabaseResolvedCityRow,
} from "../lib/reused/supabase";
import type { LlmPort } from "../lib/llm-port";
import type { StageContext, WorkflowDeps } from "../workflow/types";
import { resolveConfig, type WorkflowConfig } from "../config/workflow.config";

export interface RecordedCall {
  fn: keyof SupabaseBackend;
  args: unknown;
}

type Canned<Args, Result> = Result | ((args: Args) => Result | Promise<Result>) | Error;

export interface FakeBackendOptions {
  resolveCityFuzzy?: Canned<string, SupabaseResolvedCityRow | null>;
  getPartnersByCity?: Canned<GetPartnersByCityArgs, SupabasePartnerRow[]>;
  cityCentroids?: Canned<void, SupabaseCityCentroidRow[]>;
  matchPartners?: Canned<MatchPartnersArgs, SupabaseMatchPartnersRow[]>;
  getPartnerProfiles?: Canned<number[], SupabasePartnerProfileRow[]>;
  getPartnerEmbeddings?: Canned<number[], SupabasePartnerEmbeddingRow[]>;
}

export interface FakeBackend extends SupabaseBackend {
  calls: RecordedCall[];
  callsTo(fn: keyof SupabaseBackend): RecordedCall[];
  /** Cities passed to matchPartners, in call order. */
  searchedCities(): string[];
}

async function canned<Args, Result>(c: Canned<Args, Result> | undefined, fallback: Result, args: Args): Promise<Result> {
  if (c === undefined) return fallback;
  if (c instanceof Error) throw c;
  if (typeof c === "function") return await (c as (a: Args) => Result | Promise<Result>)(args);
  return c;
}

export function fakeBackend(opts: FakeBackendOptions = {}): FakeBackend {
  const calls: RecordedCall[] = [];
  const rec = (fn: keyof SupabaseBackend, args: unknown) => calls.push({ fn, args });
  return {
    calls,
    callsTo: (fn) => calls.filter((c) => c.fn === fn),
    searchedCities: () =>
      calls.filter((c) => c.fn === "matchPartners").map((c) => (c.args as MatchPartnersArgs).filters.city ?? ""),
    async resolveCityFuzzy(place: string, _o?: CallOpts) {
      rec("resolveCityFuzzy", place);
      return canned(opts.resolveCityFuzzy, null, place);
    },
    async getPartnersByCity(args, _o?) {
      rec("getPartnersByCity", args);
      return canned(opts.getPartnersByCity, [], args);
    },
    async cityCentroids(_o?) {
      rec("cityCentroids", undefined);
      return canned(opts.cityCentroids, [], undefined as void);
    },
    async matchPartners(args, _o?) {
      rec("matchPartners", args);
      return canned(opts.matchPartners, [], args);
    },
    async getPartnerProfiles(ids, _o?) {
      rec("getPartnerProfiles", ids);
      return canned(opts.getPartnerProfiles, [], ids);
    },
    async getPartnerEmbeddings(ids, _o?) {
      rec("getPartnerEmbeddings", ids);
      return canned(opts.getPartnerEmbeddings, [], ids);
    },
  };
}

// ── Row builders ─────────────────────────────────────────────────────────────

export function matchRow(p: Pick<SupabaseMatchPartnersRow, "partner_id" | "title"> & Partial<SupabaseMatchPartnersRow>): SupabaseMatchPartnersRow {
  return { city: null, tags: null, distance_km: null, similarity: null, fts_rank: null, name_sim: null, tag_overlap: null, rrf_score: 0, ...p };
}

export function profileRow(p: Pick<SupabasePartnerProfileRow, "partner_id" | "title"> & Partial<SupabasePartnerProfileRow>): SupabasePartnerProfileRow {
  return {
    city: null, street: null, postal_code: null, tags: null, courses_text: null, body_markdown: null,
    email: null, phone: null, website_url: null, llm_profile: `Profile of ${p.title}`, profile_data: null, logo_url: null, ...p,
  };
}

/** A 1536-dim unit-ish vector whose cosine with `unit(1)` is `cos`. */
export function vectorWithCosine(cos: number): number[] {
  const v = new Array(1536).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
export const QUERY_VECTOR: number[] = (() => { const v = new Array(1536).fill(0); v[0] = 1; return v; })();

// ── A small Ruhr-area world used by most pipeline tests ──────────────────────

export const CENTROIDS: SupabaseCityCentroidRow[] = [
  { city: "Dortmund", lat: 51.5136, lon: 7.4653, cnt: 20 },
  { city: "Bochum", lat: 51.4818, lon: 7.2162, cnt: 30 },      // ~17 km
  { city: "Lünen", lat: 51.6167, lon: 7.5167, cnt: 3 },        // ~12 km
  { city: "Castrop-Rauxel", lat: 51.55, lon: 7.3167, cnt: 2 }, // ~11 km
  { city: "Hagen", lat: 51.3671, lon: 7.4633, cnt: 5 },        // ~16 km
  { city: "Essen", lat: 51.4556, lon: 7.0116, cnt: 25 },       // ~32 km
  { city: "Hamburg", lat: 53.5511, lon: 9.9937, cnt: 36 },     // ~290 km — never "nearby"
];

export const CITY_ROWS: Record<string, SupabaseResolvedCityRow> = {
  dortmund: { city: "Dortmund", lat: 51.5136, lon: 7.4653, sim: 1 },
  bochum: { city: "Bochum", lat: 51.4818, lon: 7.2162, sim: 1 },
  essen: { city: "Essen", lat: 51.4556, lon: 7.0116, sim: 1 },
  duisburg: { city: "Duisburg", lat: 51.4344, lon: 6.7623, sim: 1 },
};

export function resolveKnownCity(place: string): SupabaseResolvedCityRow | null {
  return CITY_ROWS[place.trim().toLowerCase()] ?? null;
}

/**
 * Partners per city: id ranges keep them distinct. `relevance` map lets a
 * test set the stored-embedding cosine per partner; default 0.5.
 */
export interface WorldOptions {
  partnersPerCity?: Record<string, number[]>;
  relevance?: Record<number, number>;
  /** Cities whose matchPartners call should throw. */
  failCities?: string[];
}

export function ruhrWorld(o: WorldOptions = {}): FakeBackend {
  const perCity: Record<string, number[]> = o.partnersPerCity ?? {
    Dortmund: [101, 102, 103, 104, 105, 106, 107],
    Bochum: [201, 202, 203],
    Lünen: [301],
    "Castrop-Rauxel": [401],
    Hagen: [501, 502],
    Essen: [601, 602, 603, 604],
  };
  const nameOf = (id: number, city: string) => `Partner ${id} (${city})`;
  return fakeBackend({
    resolveCityFuzzy: resolveKnownCity,
    cityCentroids: CENTROIDS,
    matchPartners: (args) => {
      const city = args.filters.city ?? "";
      if (o.failCities?.includes(city)) throw new Error(`db down for ${city}`);
      const ids = perCity[city] ?? [];
      return ids.slice(0, args.matchCount).map((id, i) =>
        matchRow({ partner_id: id, title: nameOf(id, city), city, similarity: 0.5 - i * 0.01, rrf_score: 1 / (i + 1) }),
      );
    },
    getPartnerEmbeddings: (ids) => ids.map((id) => ({ id, embedding: vectorWithCosine(o.relevance?.[id] ?? 0.5) })),
    getPartnerProfiles: (ids) =>
      ids.map((id) => {
        const city = Object.entries(perCity).find(([, list]) => list.includes(id))?.[0] ?? "?";
        return profileRow({ partner_id: id, title: nameOf(id, city), city });
      }),
  });
}

export const embedQuery = async (): Promise<number[]> => QUERY_VECTOR;

// ── Workflow fakes ────────────────────────────────────────────────────────────

export interface FakeEmbed {
  (text: string, opts?: { signal?: AbortSignal }): Promise<number[]>;
  calls: string[];
}
export function fakeEmbed(vector: number[] = QUERY_VECTOR, fail?: Error): FakeEmbed {
  const calls: string[] = [];
  const fn = (async (text: string) => {
    calls.push(text);
    if (fail) throw fail;
    return vector;
  }) as FakeEmbed;
  fn.calls = calls;
  return fn;
}

export interface FakeLlmOptions {
  cityMention?: string | null | ((query: string) => string | null);
  reformulated?: string | ((query: string) => string);
  answer?: string | ((prompt: string) => string);
  failDetect?: Error;
  failReformulate?: Error;
  failAnswer?: Error;
}
export interface FakeLlm extends LlmPort {
  calls: Array<{ fn: "detectCity" | "reformulate" | "answer"; arg: string }>;
}
export function fakeLlm(o: FakeLlmOptions = {}): FakeLlm {
  const calls: FakeLlm["calls"] = [];
  return {
    modelName: "fake-model",
    calls,
    async detectCity(query, opts) {
      calls.push({ fn: "detectCity", arg: query });
      if (o.failDetect) throw o.failDetect;
      const m = typeof o.cityMention === "function" ? o.cityMention(query) : o.cityMention;
      return { cityMention: m === undefined ? null : m };
    },
    async reformulate(query, opts) {
      calls.push({ fn: "reformulate", arg: query });
      if (o.failReformulate) throw o.failReformulate;
      if (o.reformulated === undefined) return `REFORMULATED: ${query}`;
      return typeof o.reformulated === "function" ? o.reformulated(query) : o.reformulated;
    },
    async answer(prompt, opts) {
      calls.push({ fn: "answer", arg: prompt });
      if (o.failAnswer) throw o.failAnswer;
      if (o.answer === undefined) return "ANSWER";
      return typeof o.answer === "function" ? o.answer(prompt) : o.answer;
    },
  };
}

export function deps(over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return { backend: over.backend ?? ruhrWorld(), embed: over.embed ?? fakeEmbed(), llm: over.llm ?? fakeLlm() };
}

export function ctx(config: Partial<WorkflowConfig> = {}, d: Partial<WorkflowDeps> = {}): StageContext {
  return { config: resolveConfig(config, {} as NodeJS.ProcessEnv), deps: deps(d), signal: AbortSignal.timeout(5000) };
}
