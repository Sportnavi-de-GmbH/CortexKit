/**
 * config/workflow.config.ts — every tunable of the V3 workflow, in one place.
 * Precedence: per-request override > env (V3_*) > DEFAULT_CONFIG. Nothing
 * else in this folder hard-codes these numbers.
 */

export type RerankerName = "embedding";

export interface WorkflowConfig {
  /** Forces stage 1 to this city (dev-UI override). Undefined = detect from the query. */
  targetCity?: string;
  /** Below this fuzzy-resolution similarity a city candidate is treated as unknown. */
  cityConfidenceMin: number;
  /** Stage 2: rewrite the question into a descriptive retrieval query. */
  enableQueryReformulation: boolean;
  /** Stage 2: hard cap on the retrieval query length. */
  maxRetrievalQueryChars: number;
  /** Stage 3/5: radius for "nearby"; also the distance at which the penalty maxes out. */
  searchRadiusKm: number;
  /** Stage 3: how many NEAREST cities to search. */
  maxNearbyCities: number;
  /** Stage 3: extra best-supplied cities inside the radius. */
  maxNearbyHubs: number;
  /** Stage 3/4: search the target city itself. */
  includeTargetCity: boolean;
  /** Stage 4: candidates per city (match_partners vector branch caps at 40). */
  topKSimilarity: number;
  /** Stage 4: drop rows whose directory similarity is below this. */
  similarityThreshold: number;
  /** Stage 4: concurrent per-city searches. */
  maxParallelSearches: number;
  /** Stage 5: how many partners survive the rerank (what the user sees). */
  topKReranked: number;
  /** Stage 5: added to a target-city partner's relevance. */
  targetCityBonus: number;
  /** Stage 5: penalty at `searchRadiusKm`, scaled linearly from 0 at the target city. */
  maxDistancePenalty: number;
  /** Stage 5: nearby partners below this relevance are dropped; target-city ones never are. */
  minNearbyRelevance: number;
  /** Stage 5: which reranker implementation. */
  reranker: RerankerName;
  /** Whole-run deadline. */
  runTimeoutMs: number;
  /** One directory / embedding / model round trip. */
  callTimeoutMs: number;
}

export const DEFAULT_CONFIG: WorkflowConfig = {
  cityConfidenceMin: 0.6,
  enableQueryReformulation: true,
  maxRetrievalQueryChars: 400,
  searchRadiusKm: 30,
  maxNearbyCities: 5,
  maxNearbyHubs: 2,
  includeTargetCity: true,
  topKSimilarity: 15,
  similarityThreshold: 0.2,
  maxParallelSearches: 4,
  topKReranked: 5,
  targetCityBonus: 0.05,
  maxDistancePenalty: 0.05,
  minNearbyRelevance: 0.15,
  reranker: "embedding",
  runTimeoutMs: 30_000,
  callTimeoutMs: 8_000,
};

type EnvKey = Exclude<keyof WorkflowConfig, "targetCity">;

export const V3_ENV: Record<EnvKey, string> = {
  cityConfidenceMin: "V3_CITY_CONFIDENCE_MIN",
  enableQueryReformulation: "V3_ENABLE_REFORMULATION",
  maxRetrievalQueryChars: "V3_MAX_RETRIEVAL_QUERY_CHARS",
  searchRadiusKm: "V3_SEARCH_RADIUS_KM",
  maxNearbyCities: "V3_MAX_NEARBY_CITIES",
  maxNearbyHubs: "V3_MAX_NEARBY_HUBS",
  includeTargetCity: "V3_INCLUDE_TARGET_CITY",
  topKSimilarity: "V3_TOP_K_SIMILARITY",
  similarityThreshold: "V3_SIMILARITY_THRESHOLD",
  maxParallelSearches: "V3_MAX_PARALLEL_SEARCHES",
  topKReranked: "V3_TOP_K_RERANKED",
  targetCityBonus: "V3_TARGET_CITY_BONUS",
  maxDistancePenalty: "V3_MAX_DISTANCE_PENALTY",
  minNearbyRelevance: "V3_MIN_NEARBY_RELEVANCE",
  reranker: "V3_RERANKER",
  runTimeoutMs: "V3_RUN_TIMEOUT_MS",
  callTimeoutMs: "V3_CALL_TIMEOUT_MS",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseEnvValue(key: EnvKey, raw: string): unknown {
  const v = raw.trim();
  if (v === "") return undefined;
  const kind = typeof DEFAULT_CONFIG[key];
  if (kind === "boolean") {
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return undefined;
  }
  if (kind === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return v;
}

/** Reads V3_* env dials; unparsable values fall back to the default. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { config: WorkflowConfig; envSet: string[] } {
  const config: WorkflowConfig = { ...DEFAULT_CONFIG };
  const envSet: string[] = [];
  for (const key of Object.keys(V3_ENV) as EnvKey[]) {
    const raw = env[V3_ENV[key]];
    if (raw === undefined) continue;
    const parsed = parseEnvValue(key, raw);
    if (parsed === undefined) continue;
    (config as unknown as Record<string, unknown>)[key] = parsed;
    envSet.push(key);
  }
  return { config, envSet };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new ConfigError(msg);
}

export function validateConfig(c: WorkflowConfig): WorkflowConfig {
  const int = (n: number) => Number.isInteger(n);
  assert(c.cityConfidenceMin >= 0 && c.cityConfidenceMin <= 1, "cityConfidenceMin must be within [0,1]");
  assert(int(c.maxRetrievalQueryChars) && c.maxRetrievalQueryChars >= 50, "maxRetrievalQueryChars must be an integer >= 50");
  assert(c.searchRadiusKm > 0, "searchRadiusKm must be > 0");
  assert(int(c.maxNearbyCities) && c.maxNearbyCities >= 0, "maxNearbyCities must be an integer >= 0");
  assert(int(c.maxNearbyHubs) && c.maxNearbyHubs >= 0, "maxNearbyHubs must be an integer >= 0");
  assert(int(c.topKSimilarity) && c.topKSimilarity >= 1 && c.topKSimilarity <= 40, "topKSimilarity must be an integer in [1,40] (match_partners caps at 40)");
  assert(c.similarityThreshold >= 0 && c.similarityThreshold <= 1, "similarityThreshold must be within [0,1]");
  assert(int(c.maxParallelSearches) && c.maxParallelSearches >= 1, "maxParallelSearches must be an integer >= 1");
  assert(int(c.topKReranked) && c.topKReranked >= 1, "topKReranked must be an integer >= 1");
  assert(c.targetCityBonus >= 0 && c.targetCityBonus <= 1, "targetCityBonus must be within [0,1]");
  assert(c.maxDistancePenalty >= 0 && c.maxDistancePenalty <= 1, "maxDistancePenalty must be within [0,1]");
  assert(c.minNearbyRelevance >= 0 && c.minNearbyRelevance <= 1, "minNearbyRelevance must be within [0,1]");
  assert(c.reranker === "embedding", `unknown reranker "${String(c.reranker)}"`);
  assert(int(c.runTimeoutMs) && c.runTimeoutMs >= 1000, "runTimeoutMs must be an integer >= 1000");
  assert(int(c.callTimeoutMs) && c.callTimeoutMs >= 100, "callTimeoutMs must be an integer >= 100");
  return c;
}

/** override > env > default, then validated. `targetCity` is trimmed; blank ⇒ undefined. */
export function resolveConfig(overrides: Partial<WorkflowConfig> = {}, env: NodeJS.ProcessEnv = process.env): WorkflowConfig {
  const { config } = loadConfigFromEnv(env);
  const merged: WorkflowConfig = { ...config };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  const tc = typeof merged.targetCity === "string" ? merged.targetCity.trim() : undefined;
  if (tc) merged.targetCity = tc; else delete merged.targetCity;
  return validateConfig(merged);
}
