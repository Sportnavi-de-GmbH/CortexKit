# Partner Retrieval Workflow V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new, independent project `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/` that runs the six-stage partner-retrieval pipeline (detect city → reformulate → nearby cities → embed once + per-city search → rerank → answer) behind a Next.js API route, with a developer UI that shows every stage.

**Architecture:** A pure TypeScript `runWorkflow()` records a `StageRecord` per stage into a `WorkflowTrace` and never throws. All I/O goes through three injectable ports (directory backend, embedding function, LLM port) so every test runs offline against fakes. The dev UI is one Next.js page that POSTs to `/api/workflow` and renders the trace as collapsible stage sections.

**Tech Stack:** Next.js 15.5 (app router, `next dev` only — no eve), React 19, TypeScript 5.9 strict, AI SDK `ai@^7` + `@ai-sdk/openai` (Azure), `@supabase/supabase-js`, `zod@^4`, Tailwind 4, vitest 4, tsx.

Spec: `docs/superpowers/specs/2026-09-14-partner-retrieval-v3-design.md`.

## Global Constraints

- **Nothing outside `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/` is modified** (except this plan/spec). Never import from `../partner-recommendation-agent-v2`, `-supabase` or `-convex`; copy leaf modules into `lib/reused/` with a header naming the source (V2's rule).
- Env variable names are identical to V2: `AZURE_AI_CHATBOT_OPENAI_ENDPOINT`, `AZURE_AI_CHATBOT_API_KEY`, `AZURE_AI_CHATBOT_DEPLOYMENT_NAME`, `MEMORY_SUPABASE_URL`, `MEMORY_SUPABASE_SERVICE_ROLE_KEY`, `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`. Dials are `V3_*`.
- Local port **3008**. `match_partners` accepts ONE city per call and caps its vector branch at 40 rows ⇒ `topKSimilarity ≤ 40`.
- **Exactly one embedding call per run**, regardless of city count. `original_user_query` is never altered; `retrieval_query` is what gets embedded.
- Scores: `finalScore = relevance + locationTerm`; a clearly more relevant nearby partner may outrank a weak target-city partner.
- The runner never throws; the API always returns a trace for a valid body.
- Commit messages: **no `Co-Authored-By` / Claude attribution trailers** (CortexKit CLAUDE.md §13 overrides the harness default). Commit from the CortexKit repo root; all V3 paths are relative to `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/` unless prefixed.
- Windows/PowerShell environment; run npm commands from inside the V3 folder.

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.mjs`, `postcss.config.mjs`, `.gitignore`, `.env.local.example` | project scaffolding |
| `lib/reused/{supabase,embeddings,score-relevance,llm,load-env,timeout,cache,nearby-cities,limiter}.ts` | unchanged copies from V2 |
| `lib/llm-port.ts` | `LlmPort` interface + Azure implementation (`generateObject`/`generateText`) |
| `config/workflow.config.ts` | `WorkflowConfig`, defaults, env loading, override merge, validation |
| `workflow/types.ts` | input/trace/stage/candidate types + `WorkflowDeps` |
| `workflow/stages/1-detect-city.ts` … `6-respond.ts` | one stage each, `(input, ctx) → StageResult` |
| `workflow/run-workflow.ts` | sequential runner, stage recording, stop-on-failure, deadline |
| `workflow/deps.ts` | real deps (Supabase facade, `embedText`, Azure LLM port) |
| `app/api/workflow/route.ts` | POST run / GET defaults |
| `app/layout.tsx`, `app/globals.css`, `app/page.tsx` | the dev UI page |
| `components/*.tsx` | `QueryForm`, `ConfigPanel`, `StageSection`, `JsonBlock`, stage views, `RunHistory` |
| `scripts/run.ts` | CLI: print a trace against the live directory |
| `tests/_fakes.ts`, `tests/*.test.ts` | offline tests |
| `README.md` | how to run, what it does |

---

### Task 1: Scaffold the project and copy the reused modules

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.mjs`, `postcss.config.mjs`, `.gitignore`, `.env.local.example`
- Create (copies): `lib/reused/supabase.ts`, `lib/reused/embeddings.ts`, `lib/reused/score-relevance.ts`, `lib/reused/llm.ts`, `lib/reused/load-env.ts`, `lib/reused/timeout.ts`, `lib/reused/cache.ts`, `lib/reused/nearby-cities.ts`, `lib/reused/limiter.ts`
- Test: `tests/reused.test.ts`

**Interfaces:**
- Produces (from the copies): `SupabaseBackend` (`resolveCityFuzzy(place) → {city,lat,lon,sim}|null`, `cityCentroids() → {city,lat,lon,cnt}[]`, `matchPartners({queryEmbedding,queryText,filters:{city?,tags?,excludeIds?},matchCount}) → SupabaseMatchPartnersRow[]`, `getPartnerProfiles(ids) → SupabasePartnerProfileRow[]`, `getPartnerEmbeddings(ids) → {id,embedding}[]`), `getSupabase()`, `embedText(text,{signal}) → number[]`, `scoreRelevance(queryVec, Map<id,vec>) → Map<id,number>`, `roundScore`, `getAzureChatModel()`, `withTimeout`, `timeoutSignal`, `TimeoutError`, `createTtlCache`, `findNearbyCities({home:{canonical,centroid:{lat,lng}},limit,hubs?,maxDistanceKm}, backend) → NearbyCity[]` (`{city,centroid,distanceKm,partnerCount}`), `haversineKm`, `normalizeCityKey`, `runWithLimit(tasks, limit) → Settled<T>[]`.

- [ ] **Step 1: Create the folder and `package.json`**

`SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/package.json`:

```json
{
  "name": "partner-recommendation-agent-v3",
  "private": true,
  "type": "module",
  "version": "3.0.0",
  "description": "Navio partner-retrieval workflow V3 — sequential pipeline (detect city → reformulate → nearby cities → one embedding → per-city similarity search → rerank → answer) with a developer UI. Independent of the existing agents.",
  "scripts": {
    "dev": "next dev",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "workflow": "tsx scripts/run.ts"
  },
  "dependencies": {
    "@ai-sdk/openai": "^4.0.16",
    "@supabase/supabase-js": "^2.110.7",
    "@tailwindcss/postcss": "^4.3.3",
    "ai": "^7.0.31",
    "next": "^15.5.25",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-markdown": "^9.1.0",
    "tailwindcss": "^4.3.3",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "dotenv": "^17.4.2",
    "tsx": "^4.23.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `vitest.config.ts`, `next.config.mjs`, `postcss.config.mjs`, `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] },
    "allowJs": true
  },
  "include": ["lib", "config", "workflow", "scripts", "tests", "app", "components", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

`next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
```

`postcss.config.mjs`:
```js
const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
```

`.gitignore`:
```
node_modules/
.env
.env.*
!.env.local.example
dist/
.next/
next-env.d.ts
tsconfig.tsbuildinfo
```

- [ ] **Step 3: Create `.env.local.example`**

```
# partner-recommendation-agent-v3 — copy to .env.local (gitignored). Same credentials and
# variable names as ../partner-recommendation-agent-v2/.env.local.

# Chat model (Azure OpenAI) — used for city detection, reformulation and the final answer
AZURE_AI_CHATBOT_OPENAI_ENDPOINT=
AZURE_AI_CHATBOT_API_KEY=
AZURE_AI_CHATBOT_DEPLOYMENT_NAME=gpt-4.1

# Partner directory (SERVICE ROLE key is mandatory — RLS with no policies)
MEMORY_SUPABASE_URL=
MEMORY_SUPABASE_SERVICE_ROLE_KEY=

# Embeddings (text-embedding-3-small, 1536-dim)
EMBEDDING_API_URL=
EMBEDDING_API_KEY=

# ── V3 dials (all optional; defaults shown; the dev UI can override per run) ──
# V3_CITY_CONFIDENCE_MIN=0.6
# V3_ENABLE_REFORMULATION=true
# V3_MAX_RETRIEVAL_QUERY_CHARS=400
# V3_SEARCH_RADIUS_KM=30
# V3_MAX_NEARBY_CITIES=5
# V3_MAX_NEARBY_HUBS=2
# V3_INCLUDE_TARGET_CITY=true
# V3_TOP_K_SIMILARITY=15
# V3_SIMILARITY_THRESHOLD=0.2
# V3_MAX_PARALLEL_SEARCHES=4
# V3_TOP_K_RERANKED=5
# V3_TARGET_CITY_BONUS=0.05
# V3_MAX_DISTANCE_PENALTY=0.05
# V3_MIN_NEARBY_RELEVANCE=0.15
# V3_RERANKER=embedding
# V3_RUN_TIMEOUT_MS=30000
# V3_CALL_TIMEOUT_MS=8000
```

- [ ] **Step 4: Copy the reused modules from V2 and fix their relative imports**

Run from the CortexKit root (PowerShell):
```powershell
$src = "SportnaviPartnerRecomandationBot\partner-recommendation-agent-v2"
$dst = "SportnaviPartnerRecomandationBot\partner-recommendation-agent-v3"
New-Item -ItemType Directory -Force "$dst\lib\reused" | Out-Null
foreach ($f in "supabase","embeddings","score-relevance","llm","load-env","timeout","cache") {
  Copy-Item "$src\lib\reused\$f.ts" "$dst\lib\reused\$f.ts"
}
Copy-Item "$src\search\nearby-cities.ts" "$dst\lib\reused\nearby-cities.ts"
Copy-Item "$src\concurrency\limiter.ts"  "$dst\lib\reused\limiter.ts"
```
Then edit `lib/reused/nearby-cities.ts` lines 19–20 so the imports are siblings:
```ts
import type { SupabaseBackend } from "./supabase";
import { createTtlCache, type TtlCache } from "./cache";
```
Prepend to `lib/reused/nearby-cities.ts` and `lib/reused/limiter.ts` (first lines):
```ts
// V3 COPY — copied from ../partner-recommendation-agent-v2/search/nearby-cities.ts on 2026-09-14
// (only the two relative imports changed to sibling paths). V3 never imports from V2's tree.
```
(and the matching line for `concurrency/limiter.ts`). The other seven files already carry a "V2 COPY" header — add one line below it: `// V3 COPY — re-copied unchanged from ../partner-recommendation-agent-v2/lib/reused/<name>.ts on 2026-09-14.`

- [ ] **Step 5: Write a smoke test for the copies**

`tests/reused.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cosineSimilarity, roundScore, scoreRelevance } from "../lib/reused/score-relevance";
import { haversineKm, normalizeCityKey } from "../lib/reused/nearby-cities";
import { runWithLimit } from "../lib/reused/limiter";
import { withTimeout, TimeoutError } from "../lib/reused/timeout";

describe("reused modules", () => {
  it("scores cosine relevance rounded to 4 dp", () => {
    const q = [1, 0];
    const scores = scoreRelevance(q, new Map([[1, [1, 0]], [2, [0, 1]], [3, [0.7071, 0.7071]]]));
    expect(scores.get(1)).toBe(1);
    expect(scores.get(2)).toBe(0);
    expect(scores.get(3)).toBe(0.7071);
    expect(roundScore(cosineSimilarity([1, 1], [1, 1]))).toBe(1);
  });

  it("measures Dortmund→Bochum at roughly 17 km", () => {
    const km = haversineKm({ lat: 51.5136, lng: 7.4653 }, { lat: 51.4818, lng: 7.2162 });
    expect(km).toBeGreaterThan(16);
    expect(km).toBeLessThan(19);
    expect(normalizeCityKey("  Düsseldorf ")).toBe("duesseldorf");
  });

  it("bounds concurrency and settles every task", async () => {
    const stats = { peakConcurrency: 0 };
    const results = await runWithLimit([async () => 1, async () => { throw new Error("x"); }], 1, stats);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]?.status).toBe("rejected");
    expect(stats.peakConcurrency).toBe(1);
  });

  it("times out", async () => {
    await expect(withTimeout(new Promise(() => {}), 5, "never")).rejects.toBeInstanceOf(TimeoutError);
  });
});
```

- [ ] **Step 6: Install and run**

```powershell
cd SportnaviPartnerRecomandationBot\partner-recommendation-agent-v3
npm install
npm test
```
Expected: 4 tests pass. (`npm run typecheck` will complain about missing `app/` until Task 12 — `include` lists it but an empty match is fine; if tsc errors on `.next/types`, that is expected until `next dev` has run once.)

- [ ] **Step 7: Commit**

```powershell
cd C:\Users\moham\Documents\GitHub\CortexKit
git add SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3 docs/superpowers/specs/2026-09-14-partner-retrieval-v3-design.md docs/superpowers/plans/2026-09-14-partner-retrieval-v3.md
git commit -m "v3: scaffold the partner-retrieval workflow project and copy the reused leaf modules"
```

---

### Task 2: Configuration module

**Files:**
- Create: `config/workflow.config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkflowConfig {
    targetCity?: string; cityConfidenceMin: number;
    enableQueryReformulation: boolean; maxRetrievalQueryChars: number;
    searchRadiusKm: number; maxNearbyCities: number; maxNearbyHubs: number; includeTargetCity: boolean;
    topKSimilarity: number; similarityThreshold: number; maxParallelSearches: number;
    topKReranked: number; targetCityBonus: number; maxDistancePenalty: number; minNearbyRelevance: number;
    reranker: "embedding"; runTimeoutMs: number; callTimeoutMs: number;
  }
  export const DEFAULT_CONFIG: WorkflowConfig;
  export const V3_ENV: Record<Exclude<keyof WorkflowConfig, "targetCity">, string>;
  export function loadConfigFromEnv(env?: NodeJs.ProcessEnv): { config: WorkflowConfig; envSet: string[] };
  export function resolveConfig(overrides?: Partial<WorkflowConfig>, env?: NodeJS.ProcessEnv): WorkflowConfig; // override > env > default, validated
  export class ConfigError extends Error {}
  ```

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, loadConfigFromEnv, resolveConfig } from "../config/workflow.config";

describe("workflow config", () => {
  it("has the spec defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      cityConfidenceMin: 0.6, enableQueryReformulation: true, maxRetrievalQueryChars: 400,
      searchRadiusKm: 30, maxNearbyCities: 5, maxNearbyHubs: 2, includeTargetCity: true,
      topKSimilarity: 15, similarityThreshold: 0.2, maxParallelSearches: 4,
      topKReranked: 5, targetCityBonus: 0.05, maxDistancePenalty: 0.05, minNearbyRelevance: 0.15,
      reranker: "embedding", runTimeoutMs: 30_000, callTimeoutMs: 8_000,
    });
    expect(DEFAULT_CONFIG.targetCity).toBeUndefined();
  });

  it("reads env overrides and reports which were set", () => {
    const { config, envSet } = loadConfigFromEnv({
      V3_SEARCH_RADIUS_KM: "45", V3_ENABLE_REFORMULATION: "false", V3_TOP_K_SIMILARITY: "20",
    } as NodeJS.ProcessEnv);
    expect(config.searchRadiusKm).toBe(45);
    expect(config.enableQueryReformulation).toBe(false);
    expect(config.topKSimilarity).toBe(20);
    expect(envSet.sort()).toEqual(["enableQueryReformulation", "searchRadiusKm", "topKSimilarity"]);
  });

  it("ignores blank or non-numeric env values", () => {
    const { config, envSet } = loadConfigFromEnv({ V3_SEARCH_RADIUS_KM: "", V3_TOP_K_RERANKED: "abc" } as NodeJS.ProcessEnv);
    expect(config.searchRadiusKm).toBe(30);
    expect(config.topKReranked).toBe(5);
    expect(envSet).toEqual([]);
  });

  it("applies precedence override > env > default", () => {
    const cfg = resolveConfig({ searchRadiusKm: 10 }, { V3_SEARCH_RADIUS_KM: "45", V3_TOP_K_RERANKED: "7" } as NodeJS.ProcessEnv);
    expect(cfg.searchRadiusKm).toBe(10);
    expect(cfg.topKReranked).toBe(7);
    expect(cfg.maxNearbyCities).toBe(5);
  });

  it("validates ranges", () => {
    expect(() => resolveConfig({ topKSimilarity: 41 }, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ similarityThreshold: 1.5 }, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ maxParallelSearches: 0 }, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ topKReranked: 0 }, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ reranker: "llm" as never }, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("keeps an explicit targetCity override and trims it", () => {
    expect(resolveConfig({ targetCity: "  Bochum " }, {} as NodeJS.ProcessEnv).targetCity).toBe("Bochum");
    expect(resolveConfig({ targetCity: "   " }, {} as NodeJS.ProcessEnv).targetCity).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npm test -- tests/config.test.ts` → FAIL: cannot resolve `../config/workflow.config`.

- [ ] **Step 3: Implement `config/workflow.config.ts`**

```ts
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
    (config as Record<string, unknown>)[key] = parsed;
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
    if (v !== undefined && v !== null) (merged as Record<string, unknown>)[k] = v;
  }
  const tc = typeof merged.targetCity === "string" ? merged.targetCity.trim() : undefined;
  if (tc) merged.targetCity = tc; else delete merged.targetCity;
  return validateConfig(merged);
}
```

- [ ] **Step 4: Run tests**

`npm test -- tests/config.test.ts` → 6 pass.

- [ ] **Step 5: Commit**

```powershell
git add SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/config SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/tests/config.test.ts
git commit -m "v3: workflow config with env loading, override precedence and validation"
```

---

### Task 3: Workflow types, LLM port interface and test fakes

**Files:**
- Create: `workflow/types.ts`, `lib/llm-port.ts` (interface only this task; Azure impl in Task 10), `tests/_fakes.ts`
- Test: `tests/fakes.test.ts`

**Interfaces:**
- Produces (`workflow/types.ts`):
  ```ts
  export interface WorkflowInput { query: string; homeCity?: string; sessionCities?: string[] }
  export type StageId = "detect-city" | "reformulate" | "nearby-cities" | "search" | "rerank" | "respond";
  export type StageStatus = "ok" | "warning" | "error" | "skipped";
  export interface StageRecord<I = unknown, O = unknown> { id: StageId; title: string; status: StageStatus; durationMs: number; input: I; output?: O; config: Record<string, unknown>; filters?: Record<string, unknown>; counts?: Record<string, number>; warnings: string[]; error?: { message: string } }
  export interface StageResult<O> { output: O; config: Record<string, unknown>; filters?: Record<string, unknown>; counts?: Record<string, number>; warnings?: string[] }
  export interface StageContext { config: WorkflowConfig; deps: WorkflowDeps; signal: AbortSignal }
  export interface WorkflowDeps { backend: SupabaseBackend; embed: (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>; llm: LlmPort }
  export interface ResolvedCity { canonical: string; centroid: { lat: number; lng: number }; confidence: number }
  export interface CityAttempt { source: CitySource; mention: string; resolved: ResolvedCity | null; accepted: boolean; reason?: string }
  export type CitySource = "override" | "explicit" | "home" | "session";
  export interface DetectCityOutput { cityMention: string | null; target: (ResolvedCity & { source: CitySource; mention: string }) | null; attempts: CityAttempt[] }
  export interface ReformulateOutput { originalUserQuery: string; retrievalQuery: string; reformulated: boolean; model?: string }
  export interface SearchCity { city: string; role: "target" | "nearby"; distanceKm: number; partnerCount: number }
  export interface NearbyCitiesOutput { cities: SearchCity[] }
  export interface Candidate { id: number; name: string; city: string; tags: string[]; role: "target" | "nearby"; sourceCity: string; distanceKm: number; similarity: number | null; rankInCity: number }
  export interface CitySearchResult { city: string; role: "target" | "nearby"; distanceKm: number; requested: number; returned: number; kept: number; failed?: string; results: Candidate[] }
  export interface SearchOutput { embedding: { model: string; dimensions: number; preview: number[] }; retrievalQuery: string; perCity: CitySearchResult[]; candidates: Candidate[] }
  export interface RankedRow { rank: number | null; id: number; name: string; city: string; role: "target" | "nearby"; distanceKm: number; similarity: number | null; relevance: number; relevanceSource: "embedding" | "similarity" | "none"; locationTerm: number; finalScore: number; kept: boolean; dropReason?: string }
  export interface RerankOutput { reranker: string; rows: RankedRow[]; kept: RankedRow[] }
  export interface Recommendation { rank: number; id: number; name: string; city: string; role: "target" | "nearby"; distanceKm: number; finalScore: number; relevance: number; profile: string }
  export interface RespondOutput { answer: string; recommendations: Recommendation[]; profilesGiven: number; model?: string }
  export type WorkflowStatus = "ok" | "needs_clarification" | "failed";
  export interface WorkflowTrace { runId: string; startedAt: string; totalMs: number; status: WorkflowStatus; input: WorkflowInput; config: WorkflowConfig; stages: StageRecord[]; answer?: string; recommendations?: Recommendation[]; clarification?: string }
  ```
- Produces (`lib/llm-port.ts`):
  ```ts
  export interface LlmPort {
    detectCity(query: string, opts: { signal: AbortSignal }): Promise<{ cityMention: string | null }>;
    reformulate(query: string, opts: { maxChars: number; signal: AbortSignal }): Promise<string>;
    answer(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
    readonly modelName: string;
  }
  ```
- Produces (`tests/_fakes.ts`): `fakeBackend(opts)`, `ruhrWorld(opts)` (as in V2, minus `getPartnersByCity` fields not needed but still implemented), `matchRow`, `profileRow`, `vectorWithCosine`, `QUERY_VECTOR`, `CENTROIDS`, `CITY_ROWS`, `resolveKnownCity`, `fakeEmbed` (counts calls), `fakeLlm(opts)` with `{ cityMention?, reformulated?, answer?, failDetect?, failReformulate?, failAnswer? }` and recorded `calls`, `deps(overrides)` building a `WorkflowDeps`, `ctx(configOverrides, depsOverrides)` building a `StageContext` with `AbortSignal.timeout(5000)`.

- [ ] **Step 1: Write `workflow/types.ts`** with exactly the interfaces listed above (add the two imports: `import type { WorkflowConfig } from "../config/workflow.config"; import type { SupabaseBackend } from "../lib/reused/supabase"; import type { LlmPort } from "../lib/llm-port";`). Add a doc comment at the top: "Shared types. Stage modules import from here; nothing here has behaviour."

- [ ] **Step 2: Write `lib/llm-port.ts` (interface only)**

```ts
/**
 * lib/llm-port.ts — the three model calls the workflow makes, behind one
 * interface so tests use a fake and the pipeline never imports the AI SDK.
 * The Azure implementation is `createAzureLlmPort()` (added with the runner).
 */
export interface LlmPort {
  readonly modelName: string;
  /** Stage 1: the location verbatim as the user wrote it, or null. */
  detectCity(query: string, opts: { signal: AbortSignal }): Promise<{ cityMention: string | null }>;
  /** Stage 2: a descriptive German semantic-search query preserving the intent. */
  reformulate(query: string, opts: { maxChars: number; signal: AbortSignal }): Promise<string>;
  /** Stage 6: the user-facing answer from a fully rendered prompt. */
  answer(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
}
```

- [ ] **Step 3: Write `tests/_fakes.ts`**

Copy V2's `tests/_fakes.ts` (`SportnaviPartnerRecomandationBot/partner-recommendation-agent-v2/tests/_fakes.ts`) and change: import paths to `../lib/reused/supabase`; remove the `PartnerCard` import and `cardOf` helper; keep everything else (`fakeBackend`, `matchRow`, `profileRow`, `vectorWithCosine`, `QUERY_VECTOR`, `CENTROIDS`, `CITY_ROWS`, `resolveKnownCity`, `ruhrWorld`). Then append:

```ts
import type { LlmPort } from "../lib/llm-port";
import type { StageContext, WorkflowDeps } from "../workflow/types";
import { resolveConfig, type WorkflowConfig } from "../config/workflow.config";

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
    async detectCity(query) {
      calls.push({ fn: "detectCity", arg: query });
      if (o.failDetect) throw o.failDetect;
      const m = typeof o.cityMention === "function" ? o.cityMention(query) : o.cityMention;
      return { cityMention: m === undefined ? null : m };
    },
    async reformulate(query) {
      calls.push({ fn: "reformulate", arg: query });
      if (o.failReformulate) throw o.failReformulate;
      if (o.reformulated === undefined) return `REFORMULATED: ${query}`;
      return typeof o.reformulated === "function" ? o.reformulated(query) : o.reformulated;
    },
    async answer(prompt) {
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
```

- [ ] **Step 4: Write `tests/fakes.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ctx, fakeEmbed, fakeLlm, ruhrWorld } from "./_fakes";

describe("fakes", () => {
  it("ruhrWorld answers the six-method facade", async () => {
    const b = ruhrWorld();
    expect((await b.resolveCityFuzzy("dortmund"))?.city).toBe("Dortmund");
    expect((await b.cityCentroids()).length).toBe(7);
    const rows = await b.matchPartners({ queryEmbedding: null, queryText: "x", filters: { city: "Bochum" }, matchCount: 2 });
    expect(rows.map((r) => r.partner_id)).toEqual([201, 202]);
    expect(b.searchedCities()).toEqual(["Bochum"]);
  });
  it("fake embed and llm record calls", async () => {
    const e = fakeEmbed();
    await e("q");
    expect(e.calls).toEqual(["q"]);
    const l = fakeLlm({ cityMention: "Bochum" });
    expect(await l.detectCity("q", { signal: AbortSignal.timeout(100) })).toEqual({ cityMention: "Bochum" });
    expect(await l.reformulate("q", { maxChars: 100, signal: AbortSignal.timeout(100) })).toBe("REFORMULATED: q");
    expect(l.calls.map((c) => c.fn)).toEqual(["detectCity", "reformulate"]);
  });
  it("ctx builds a validated config", () => {
    expect(ctx({ searchRadiusKm: 50 }).config.searchRadiusKm).toBe(50);
  });
});
```

- [ ] **Step 5: Run**

`npm test` → all pass; `npm run typecheck` → clean (ignore `.next/types` if `app/` does not exist yet).

- [ ] **Step 6: Commit**

```powershell
git add SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3
git commit -m "v3: workflow types, LLM port interface and offline test fakes"
```

---

### Task 4: Stage 1 — detect city

**Files:**
- Create: `workflow/stages/1-detect-city.ts`
- Test: `tests/stage1-detect-city.test.ts`

**Interfaces:**
- Consumes: `LlmPort.detectCity`, `SupabaseBackend.resolveCityFuzzy`, `WorkflowConfig.targetCity/cityConfidenceMin/callTimeoutMs`.
- Produces: `export async function detectCity(input: WorkflowInput, ctx: StageContext): Promise<StageResult<DetectCityOutput>>`.

- [ ] **Step 1: Write the failing tests**

`tests/stage1-detect-city.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { detectCity } from "../workflow/stages/1-detect-city";
import { ctx, fakeBackend, fakeLlm, resolveKnownCity } from "./_fakes";

const Q = "Ich suche Physiotherapie in Dortmund";

describe("stage 1 — detect city", () => {
  it("uses the explicitly mentioned city", async () => {
    const r = await detectCity({ query: Q }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmund" }) }));
    expect(r.output.target).toMatchObject({ canonical: "Dortmund", source: "explicit", mention: "Dortmund", confidence: 1 });
    expect(r.output.attempts).toHaveLength(1);
    expect(r.output.attempts[0]?.accepted).toBe(true);
  });

  it("falls back to the home city when no city is mentioned", async () => {
    const r = await detectCity({ query: "Ich suche Yoga", homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ cityMention: null }) }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.output.cityMention).toBeNull();
  });

  it("falls back to the most recent session city after the home city", async () => {
    const r = await detectCity({ query: "Ich suche Yoga", sessionCities: ["Essen", "Bochum"] }, ctx({}, { llm: fakeLlm({ cityMention: null }) }));
    expect(r.output.target).toMatchObject({ canonical: "Essen", source: "session" });
  });

  it("an explicit targetCity override wins and skips the model", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund" });
    const r = await detectCity({ query: Q }, ctx({ targetCity: "Bochum" }, { llm }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "override" });
    expect(llm.calls).toEqual([]);
  });

  it("rejects a low-confidence resolution and moves to the next candidate", async () => {
    const backend = fakeBackend({
      resolveCityFuzzy: (p) => (p === "Dortmnd" ? { city: "Dortmund", lat: 51.5, lon: 7.4, sim: 0.4 } : resolveKnownCity(p)),
    });
    const r = await detectCity({ query: Q, homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmnd" }), backend }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.output.attempts[0]).toMatchObject({ source: "explicit", accepted: false });
    expect(r.output.attempts[0]?.reason).toMatch(/confidence/);
  });

  it("returns no target when nothing resolves (run will ask for clarification)", async () => {
    const r = await detectCity({ query: "Ich suche Yoga" }, ctx({}, { llm: fakeLlm({ cityMention: null }) }));
    expect(r.output.target).toBeNull();
    expect(r.warnings?.[0]).toMatch(/no city/i);
  });

  it("treats a model failure as 'no mention' with a warning, not an error", async () => {
    const r = await detectCity({ query: Q, homeCity: "Bochum" }, ctx({}, { llm: fakeLlm({ failDetect: new Error("azure down") }) }));
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
    expect(r.warnings?.some((w) => w.includes("azure down"))).toBe(true);
  });

  it("records the config it used", async () => {
    const r = await detectCity({ query: Q }, ctx({}, { llm: fakeLlm({ cityMention: "Dortmund" }) }));
    expect(r.config).toEqual({ cityConfidenceMin: 0.6, targetCity: undefined });
    expect(r.counts).toEqual({ attempts: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- tests/stage1` → FAIL (module missing).

- [ ] **Step 3: Implement `workflow/stages/1-detect-city.ts`**

```ts
/**
 * Stage 1 — Detect the city.
 * Order: config.targetCity (override) → city mentioned in the question (model) →
 * input.homeCity → input.sessionCities (most recent first). Every candidate is
 * resolved with the directory's fuzzy resolver; the first one at or above
 * cityConfidenceMin wins. No target ⇒ the runner asks the user.
 */
import { timeoutSignal } from "../../lib/reused/timeout";
import type { CityAttempt, CitySource, DetectCityOutput, ResolvedCity, StageContext, StageResult, WorkflowInput } from "../types";

async function resolve(mention: string, ctx: StageContext): Promise<ResolvedCity | null> {
  const row = await ctx.deps.backend.resolveCityFuzzy(mention, { signal: anySignal(ctx) });
  if (!row) return null;
  return { canonical: row.city, centroid: { lat: row.lat, lng: row.lon }, confidence: row.sim };
}

function anySignal(ctx: StageContext): AbortSignal {
  return AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
}

export async function detectCity(input: WorkflowInput, ctx: StageContext): Promise<StageResult<DetectCityOutput>> {
  const warnings: string[] = [];
  const candidates: Array<{ source: CitySource; mention: string }> = [];
  let cityMention: string | null = null;

  if (ctx.config.targetCity) {
    candidates.push({ source: "override", mention: ctx.config.targetCity });
  } else {
    try {
      cityMention = (await ctx.deps.llm.detectCity(input.query, { signal: anySignal(ctx) })).cityMention;
    } catch (e) {
      warnings.push(`City detection model call failed (${(e as Error).message}); treating the question as having no city mention.`);
    }
    if (cityMention && cityMention.trim()) candidates.push({ source: "explicit", mention: cityMention.trim() });
    if (input.homeCity?.trim()) candidates.push({ source: "home", mention: input.homeCity.trim() });
    for (const c of input.sessionCities ?? []) if (c.trim()) candidates.push({ source: "session", mention: c.trim() });
  }

  const attempts: CityAttempt[] = [];
  let target: DetectCityOutput["target"] = null;
  for (const c of candidates) {
    let resolved: ResolvedCity | null = null;
    let reason: string | undefined;
    try {
      resolved = await resolve(c.mention, ctx);
    } catch (e) {
      reason = `resolve_city_fuzzy failed: ${(e as Error).message}`;
    }
    if (!resolved) reason ??= "no matching city in the directory";
    else if (resolved.confidence < ctx.config.cityConfidenceMin)
      reason = `confidence ${resolved.confidence} below cityConfidenceMin ${ctx.config.cityConfidenceMin}`;
    const accepted = resolved !== null && reason === undefined;
    attempts.push({ source: c.source, mention: c.mention, resolved, accepted, ...(reason ? { reason } : {}) });
    if (accepted && resolved) {
      target = { ...resolved, source: c.source, mention: c.mention };
      break;
    }
  }

  if (!target) warnings.push("No city could be determined from the question, the home city or the session.");

  return {
    output: { cityMention, target, attempts },
    config: { cityConfidenceMin: ctx.config.cityConfidenceMin, targetCity: ctx.config.targetCity },
    counts: { attempts: attempts.length },
    warnings,
  };
}
```

- [ ] **Step 4: Run** — `npm test -- tests/stage1` → 8 pass.

- [ ] **Step 5: Commit** — `git add …/workflow/stages/1-detect-city.ts …/tests/stage1-detect-city.test.ts; git commit -m "v3: stage 1 detect city (override → mention → home → session)"`

---

### Task 5: Stage 2 — reformulate

**Files:**
- Create: `workflow/stages/2-reformulate.ts`
- Test: `tests/stage2-reformulate.test.ts`

**Interfaces:**
- Produces: `export async function reformulate(input: { query: string }, ctx: StageContext): Promise<StageResult<ReformulateOutput>>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { reformulate } from "../workflow/stages/2-reformulate";
import { ctx, fakeLlm } from "./_fakes";

const Q = "Ich suche einen Sportverein in Dortmund, der mir nach meiner Knieverletzung beim Wiedereinstieg ins Training helfen kann.";

describe("stage 2 — reformulate", () => {
  it("rewrites the question and keeps the original untouched", async () => {
    const llm = fakeLlm({ reformulated: "Sportverein in Dortmund für den Wiedereinstieg nach Knieverletzung, Rehabilitation." });
    const r = await reformulate({ query: Q }, ctx({}, { llm }));
    expect(r.output).toMatchObject({ originalUserQuery: Q, reformulated: true, model: "fake-model" });
    expect(r.output.retrievalQuery).toMatch(/Rehabilitation/);
    expect(llm.calls[0]).toEqual({ fn: "reformulate", arg: Q });
  });

  it("is the identity when disabled", async () => {
    const llm = fakeLlm();
    const r = await reformulate({ query: Q }, ctx({ enableQueryReformulation: false }, { llm }));
    expect(r.output).toEqual({ originalUserQuery: Q, retrievalQuery: Q, reformulated: false });
    expect(llm.calls).toEqual([]);
  });

  it("falls back to the original with a warning when the model fails", async () => {
    const r = await reformulate({ query: Q }, ctx({}, { llm: fakeLlm({ failReformulate: new Error("429") }) }));
    expect(r.output.retrievalQuery).toBe(Q);
    expect(r.output.reformulated).toBe(false);
    expect(r.warnings?.[0]).toMatch(/429/);
  });

  it("falls back when the model returns an empty string and truncates over-long output", async () => {
    const empty = await reformulate({ query: Q }, ctx({}, { llm: fakeLlm({ reformulated: "   " }) }));
    expect(empty.output.reformulated).toBe(false);
    const long = await reformulate({ query: Q }, ctx({ maxRetrievalQueryChars: 60 }, { llm: fakeLlm({ reformulated: "x".repeat(200) }) }));
    expect(long.output.retrievalQuery).toHaveLength(60);
    expect(long.warnings?.[0]).toMatch(/truncated/);
  });

  it("records config", async () => {
    const r = await reformulate({ query: Q }, ctx());
    expect(r.config).toEqual({ enableQueryReformulation: true, maxRetrievalQueryChars: 400 });
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `workflow/stages/2-reformulate.ts`**

```ts
/**
 * Stage 2 — Reformulate the question into a descriptive retrieval query.
 * `originalUserQuery` is never altered; only `retrievalQuery` is embedded later.
 * Any model problem degrades to the original text with a warning.
 */
import { timeoutSignal } from "../../lib/reused/timeout";
import type { ReformulateOutput, StageContext, StageResult } from "../types";

export async function reformulate(input: { query: string }, ctx: StageContext): Promise<StageResult<ReformulateOutput>> {
  const config = {
    enableQueryReformulation: ctx.config.enableQueryReformulation,
    maxRetrievalQueryChars: ctx.config.maxRetrievalQueryChars,
  };
  const identity: ReformulateOutput = { originalUserQuery: input.query, retrievalQuery: input.query, reformulated: false };
  if (!ctx.config.enableQueryReformulation) return { output: identity, config };

  const warnings: string[] = [];
  try {
    const signal = AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
    let text = (await ctx.deps.llm.reformulate(input.query, { maxChars: ctx.config.maxRetrievalQueryChars, signal })).trim();
    if (!text) {
      warnings.push("Reformulation returned an empty query; using the original question.");
      return { output: identity, config, warnings };
    }
    if (text.length > ctx.config.maxRetrievalQueryChars) {
      warnings.push(`Reformulated query truncated from ${text.length} to ${ctx.config.maxRetrievalQueryChars} chars.`);
      text = text.slice(0, ctx.config.maxRetrievalQueryChars);
    }
    return {
      output: { originalUserQuery: input.query, retrievalQuery: text, reformulated: true, model: ctx.deps.llm.modelName },
      config,
      counts: { originalChars: input.query.length, retrievalChars: text.length },
      warnings,
    };
  } catch (e) {
    warnings.push(`Reformulation failed (${(e as Error).message}); using the original question.`);
    return { output: identity, config, warnings };
  }
}
```

- [ ] **Step 4: Run** → 5 pass. **Step 5: Commit** — `git commit -m "v3: stage 2 reformulate (always on, identity fallback)"`

---

### Task 6: Stage 3 — nearby cities

**Files:**
- Create: `workflow/stages/3-nearby-cities.ts`
- Test: `tests/stage3-nearby-cities.test.ts`

**Interfaces:**
- Consumes: `findNearbyCities` (reused), `ResolvedCity`.
- Produces: `export async function nearbyCities(input: { target: ResolvedCity }, ctx: StageContext): Promise<StageResult<NearbyCitiesOutput>>`.

- [ ] **Step 1: Tests**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { nearbyCities } from "../workflow/stages/3-nearby-cities";
import { clearNearbyCityCache } from "../lib/reused/nearby-cities";
import { ctx } from "./_fakes";

const DORTMUND = { canonical: "Dortmund", centroid: { lat: 51.5136, lng: 7.4653 }, confidence: 1 };

describe("stage 3 — nearby cities", () => {
  beforeEach(() => clearNearbyCityCache());

  it("lists the target first at 0 km, then nearby by distance inside the radius", async () => {
    const r = await nearbyCities({ target: DORTMUND }, ctx({ searchRadiusKm: 30, maxNearbyCities: 5, maxNearbyHubs: 0 }));
    const names = r.output.cities.map((c) => c.city);
    expect(names[0]).toBe("Dortmund");
    expect(r.output.cities[0]).toMatchObject({ role: "target", distanceKm: 0, partnerCount: 20 });
    expect(names).toEqual(["Dortmund", "Castrop-Rauxel", "Lünen", "Hagen", "Bochum"]); // Essen ~32 km is outside 30 km
    for (let i = 2; i < r.output.cities.length; i++) expect(r.output.cities[i]!.distanceKm).toBeGreaterThanOrEqual(r.output.cities[i - 1]!.distanceKm);
  });

  it("respects maxNearbyCities and adds hubs", async () => {
    const two = await nearbyCities({ target: DORTMUND }, ctx({ searchRadiusKm: 60, maxNearbyCities: 2, maxNearbyHubs: 0 }));
    expect(two.output.cities.map((c) => c.city)).toEqual(["Dortmund", "Castrop-Rauxel", "Lünen"]);
    const hub = await nearbyCities({ target: DORTMUND }, ctx({ searchRadiusKm: 60, maxNearbyCities: 2, maxNearbyHubs: 1 }));
    expect(hub.output.cities.map((c) => c.city)).toContain("Bochum");
  });

  it("omits the target when includeTargetCity is false", async () => {
    const r = await nearbyCities({ target: DORTMUND }, ctx({ includeTargetCity: false, maxNearbyHubs: 0 }));
    expect(r.output.cities.every((c) => c.role === "nearby")).toBe(true);
  });

  it("records counts and config", async () => {
    const r = await nearbyCities({ target: DORTMUND }, ctx({ maxNearbyHubs: 0 }));
    expect(r.counts).toEqual({ withinRadius: 4, nearbyChosen: 4, citiesToSearch: 5 });
    expect(r.config).toEqual({ searchRadiusKm: 30, maxNearbyCities: 5, maxNearbyHubs: 0, includeTargetCity: true });
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement**

```ts
/**
 * Stage 3 — Which cities to search: the target (0 km) plus the nearest
 * cities inside `searchRadiusKm` (+ best-supplied hubs), from the directory's
 * own `city_centroids()`. Ordered by distance, target first.
 */
import { findNearbyCities, haversineKm } from "../../lib/reused/nearby-cities";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { NearbyCitiesOutput, ResolvedCity, SearchCity, StageContext, StageResult } from "../types";

export async function nearbyCities(input: { target: ResolvedCity }, ctx: StageContext): Promise<StageResult<NearbyCitiesOutput>> {
  const c = ctx.config;
  const signal = AbortSignal.any([ctx.signal, timeoutSignal(c.callTimeoutMs)]);
  const home = { canonical: input.target.canonical, centroid: input.target.centroid };

  const nearby = await findNearbyCities(
    { home, limit: c.maxNearbyCities, hubs: c.maxNearbyHubs, maxDistanceKm: c.searchRadiusKm },
    ctx.deps.backend,
    { signal },
  );
  // How many cities lay inside the radius at all (for the UI), independent of the limit.
  const centroids = await ctx.deps.backend.cityCentroids({ signal });
  const withinRadius = centroids.filter(
    (r) => r.city !== input.target.canonical && haversineKm(input.target.centroid, { lat: r.lat, lng: r.lon }) <= c.searchRadiusKm,
  ).length;
  const targetCount = centroids.find((r) => r.city === input.target.canonical)?.cnt ?? 0;

  const cities: SearchCity[] = [];
  if (c.includeTargetCity) cities.push({ city: input.target.canonical, role: "target", distanceKm: 0, partnerCount: targetCount });
  for (const n of nearby) cities.push({ city: n.city, role: "nearby", distanceKm: Math.round(n.distanceKm * 10) / 10, partnerCount: n.partnerCount });

  return {
    output: { cities },
    config: { searchRadiusKm: c.searchRadiusKm, maxNearbyCities: c.maxNearbyCities, maxNearbyHubs: c.maxNearbyHubs, includeTargetCity: c.includeTargetCity },
    counts: { withinRadius, nearbyChosen: nearby.length, citiesToSearch: cities.length },
  };
}
```
Note: `findNearbyCities` reads centroids through its own TTL cache; the second `cityCentroids` call here hits the fake directly — in production it is one cheap RPC, acceptable for a lab tool. `clearNearbyCityCache` is already exported by the reused module.

- [ ] **Step 4: Run → 4 pass.** **Step 5: Commit** — `git commit -m "v3: stage 3 nearby cities (target + nearest + hubs within radius)"`

---

### Task 7: Stage 4 — embed once and search every city

**Files:**
- Create: `workflow/stages/4-search.ts`
- Test: `tests/stage4-search.test.ts`

**Interfaces:**
- Consumes: `WorkflowDeps.embed`, `backend.matchPartners`, `runWithLimit`, `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` from `lib/reused/embeddings`.
- Produces: `export async function search(input: { retrievalQuery: string; cities: SearchCity[] }, ctx: StageContext): Promise<StageResult<SearchOutput> & { queryEmbedding: number[] }>` — the full vector is returned **beside** the stage result (not inside `output`) so stage 5 can reuse it and the trace only carries the preview.

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { search } from "../workflow/stages/4-search";
import { ctx, fakeEmbed, ruhrWorld } from "./_fakes";
import type { SearchCity } from "../workflow/types";

const CITIES: SearchCity[] = [
  { city: "Dortmund", role: "target", distanceKm: 0, partnerCount: 20 },
  { city: "Bochum", role: "nearby", distanceKm: 17.3, partnerCount: 30 },
  { city: "Lünen", role: "nearby", distanceKm: 12, partnerCount: 3 },
];

describe("stage 4 — search", () => {
  it("embeds the retrieval query exactly once and searches every city with that vector", async () => {
    const embed = fakeEmbed();
    const backend = ruhrWorld();
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({ topKSimilarity: 5 }, { embed, backend }));
    expect(embed.calls).toEqual(["RQ"]);
    expect(backend.searchedCities().sort()).toEqual(["Bochum", "Dortmund", "Lünen"]);
    for (const call of backend.callsTo("matchPartners")) {
      const a = call.args as { queryEmbedding: number[]; queryText: string; matchCount: number };
      expect(a.queryEmbedding).toBe(r.queryEmbedding);
      expect(a.queryText).toBe("RQ");
      expect(a.matchCount).toBe(5);
    }
    expect(r.output.embedding).toMatchObject({ model: "text-embedding-3-small", dimensions: 1536 });
    expect(r.output.embedding.preview).toHaveLength(8);
    expect(r.output.perCity.map((c) => c.city)).toEqual(["Dortmund", "Bochum", "Lünen"]);
    expect(r.output.perCity[0]).toMatchObject({ role: "target", requested: 5, returned: 5, kept: 5 });
    expect(r.output.candidates).toHaveLength(5 + 3 + 1);
    expect(r.output.candidates.find((c) => c.id === 201)).toMatchObject({ role: "nearby", sourceCity: "Bochum", distanceKm: 17.3, rankInCity: 0 });
  });

  it("drops rows below similarityThreshold and counts them", async () => {
    // ruhrWorld similarity = 0.5 − 0.01·i ⇒ with threshold 0.485 only ranks 0 and 1 survive per city
    // (Dortmund 2 of 5, Bochum 2 of 3, Lünen 1 of 1 ⇒ 5 kept, 4 dropped)
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({ topKSimilarity: 5, similarityThreshold: 0.485 }));
    expect(r.output.perCity[0]).toMatchObject({ returned: 5, kept: 2 });
    expect(r.counts).toMatchObject({ citiesSearched: 3, candidatesReturned: 9, belowThreshold: 4, candidates: 5 });
  });

  it("a failing city is a warning, the others still return", async () => {
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({}, { backend: ruhrWorld({ failCities: ["Bochum"] }) }));
    expect(r.output.perCity.find((c) => c.city === "Bochum")).toMatchObject({ returned: 0, kept: 0, failed: expect.stringContaining("db down") });
    expect(r.warnings?.[0]).toMatch(/Bochum/);
    expect(r.output.candidates.some((c) => c.sourceCity === "Dortmund")).toBe(true);
    expect(r.counts?.citiesFailed).toBe(1);
  });

  it("bounds parallelism", async () => {
    let inFlight = 0, peak = 0;
    const backend = ruhrWorld();
    const orig = backend.matchPartners.bind(backend);
    backend.matchPartners = async (a, o) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); try { return await orig(a, o); } finally { inFlight--; } };
    await search({ retrievalQuery: "RQ", cities: CITIES }, ctx({ maxParallelSearches: 1 }, { backend }));
    expect(peak).toBe(1);
  });

  it("throws when the embedding fails (the runner records it as the stage error)", async () => {
    await expect(search({ retrievalQuery: "RQ", cities: CITIES }, ctx({}, { embed: fakeEmbed(undefined, new Error("embed down")) }))).rejects.toThrow("embed down");
  });

  it("records filters and config", async () => {
    const r = await search({ retrievalQuery: "RQ", cities: CITIES }, ctx());
    expect(r.filters).toEqual({ cities: ["Dortmund", "Bochum", "Lünen"], similarityThreshold: 0.2 });
    expect(r.config).toEqual({ topKSimilarity: 15, similarityThreshold: 0.2, maxParallelSearches: 4 });
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement**

```ts
/**
 * Stage 4 — ONE embedding of the retrieval query, then the same vector is
 * used for a similarity search in every city (bounded fan-out). A failing
 * city is a warning; a failing embedding is the stage's error.
 */
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../lib/reused/embeddings";
import { runWithLimit } from "../../lib/reused/limiter";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { Candidate, CitySearchResult, SearchCity, SearchOutput, StageContext, StageResult } from "../types";

export async function search(
  input: { retrievalQuery: string; cities: SearchCity[] },
  ctx: StageContext,
): Promise<StageResult<SearchOutput> & { queryEmbedding: number[] }> {
  const c = ctx.config;
  const callSignal = () => AbortSignal.any([ctx.signal, timeoutSignal(c.callTimeoutMs)]);

  const queryEmbedding = await ctx.deps.embed(input.retrievalQuery, { signal: callSignal() });

  const warnings: string[] = [];
  const settled = await runWithLimit(
    input.cities.map((city) => async () =>
      ctx.deps.backend.matchPartners(
        { queryEmbedding, queryText: input.retrievalQuery, filters: { city: city.city }, matchCount: c.topKSimilarity },
        { signal: callSignal() },
      ),
    ),
    c.maxParallelSearches,
  );

  let candidatesReturned = 0, belowThreshold = 0, citiesFailed = 0;
  const perCity: CitySearchResult[] = [];
  const candidates: Candidate[] = [];
  input.cities.forEach((city, i) => {
    const s = settled[i]!;
    if (s.status === "rejected") {
      citiesFailed++;
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      warnings.push(`Search in ${city.city} failed: ${msg}`);
      perCity.push({ city: city.city, role: city.role, distanceKm: city.distanceKm, requested: c.topKSimilarity, returned: 0, kept: 0, failed: msg, results: [] });
      return;
    }
    candidatesReturned += s.value.length;
    const results: Candidate[] = [];
    s.value.forEach((row, rankInCity) => {
      const similarity = typeof row.similarity === "number" ? row.similarity : null;
      if (similarity !== null && similarity < c.similarityThreshold) { belowThreshold++; return; }
      results.push({
        id: row.partner_id, name: row.title, city: row.city ?? city.city, tags: row.tags ?? [],
        role: city.role, sourceCity: city.city, distanceKm: city.distanceKm, similarity, rankInCity,
      });
    });
    perCity.push({ city: city.city, role: city.role, distanceKm: city.distanceKm, requested: c.topKSimilarity, returned: s.value.length, kept: results.length, results });
    candidates.push(...results);
  });

  return {
    queryEmbedding,
    output: {
      embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, preview: queryEmbedding.slice(0, 8).map((x) => Math.round(x * 1e4) / 1e4) },
      retrievalQuery: input.retrievalQuery,
      perCity,
      candidates,
    },
    config: { topKSimilarity: c.topKSimilarity, similarityThreshold: c.similarityThreshold, maxParallelSearches: c.maxParallelSearches },
    filters: { cities: input.cities.map((x) => x.city), similarityThreshold: c.similarityThreshold },
    counts: { citiesSearched: input.cities.length, citiesFailed, candidatesReturned, belowThreshold, candidates: candidates.length },
    warnings,
  };
}
```

- [ ] **Step 4: Run → 6 pass.** **Step 5: Commit** — `git commit -m "v3: stage 4 embed once + bounded per-city similarity search"`

---

### Task 8: Stage 5 — combine, dedupe, rerank

**Files:**
- Create: `workflow/stages/5-rerank.ts`
- Test: `tests/stage5-rerank.test.ts`

**Interfaces:**
- Consumes: `scoreRelevance`, `roundScore`, `backend.getPartnerEmbeddings`.
- Produces:
  ```ts
  export interface Reranker { name: string; rerank(candidates: Candidate[], ctx: RerankContext): Promise<RankedRow[]> }
  export interface RerankContext extends StageContext { queryEmbedding: number[] }
  export const embeddingReranker: Reranker;
  export function combineAndDedupe(candidates: Candidate[]): { unique: Candidate[]; duplicatesRemoved: number }
  export function locationTerm(role, distanceKm, cfg): number
  export async function rerank(input: { candidates: Candidate[]; queryEmbedding: number[] }, ctx: StageContext): Promise<StageResult<RerankOutput>>
  ```

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { combineAndDedupe, locationTerm, rerank } from "../workflow/stages/5-rerank";
import { ctx, ruhrWorld } from "./_fakes";
import type { Candidate } from "../workflow/types";

const cand = (id: number, city: string, role: "target" | "nearby", distanceKm: number, similarity = 0.5, rankInCity = 0): Candidate =>
  ({ id, name: `P${id}`, city, tags: [], role, sourceCity: city, distanceKm, similarity, rankInCity });

describe("stage 5 — rerank", () => {
  it("dedupes by id, target occurrence wins, then nearer", () => {
    const { unique, duplicatesRemoved } = combineAndDedupe([
      cand(1, "Bochum", "nearby", 17), cand(1, "Dortmund", "target", 0), cand(2, "Hagen", "nearby", 20), cand(2, "Lünen", "nearby", 12),
    ]);
    expect(duplicatesRemoved).toBe(2);
    expect(unique.find((c) => c.id === 1)?.role).toBe("target");
    expect(unique.find((c) => c.id === 2)?.sourceCity).toBe("Lünen");
  });

  it("location term: +bonus in the target city, linear penalty up to the radius, clamped", () => {
    const cfg = ctx({ searchRadiusKm: 30, targetCityBonus: 0.05, maxDistancePenalty: 0.05 }).config;
    expect(locationTerm("target", 0, cfg)).toBe(0.05);
    expect(locationTerm("nearby", 15, cfg)).toBeCloseTo(-0.025, 6);
    expect(locationTerm("nearby", 30, cfg)).toBeCloseTo(-0.05, 6);
    expect(locationTerm("nearby", 60, cfg)).toBeCloseTo(-0.05, 6);
  });

  it("the owner's example: a clearly more relevant nearby partner beats a weak target partner, a strong target partner still wins", async () => {
    // A 0.78 Dortmund · B 0.65 Dortmund · C 0.86 Bochum 18 km · D 0.81 Lünen 15 km · E 0.72 Hagen 20 km
    const backend = ruhrWorld({ relevance: { 101: 0.78, 102: 0.65, 201: 0.86, 301: 0.81, 501: 0.72 } });
    const candidates = [cand(101, "Dortmund", "target", 0), cand(102, "Dortmund", "target", 0), cand(201, "Bochum", "nearby", 18), cand(301, "Lünen", "nearby", 15), cand(501, "Hagen", "nearby", 20)];
    const r = await rerank({ candidates, queryEmbedding: [1] }, ctx({ searchRadiusKm: 30, topKReranked: 5 }, { backend }));
    expect(r.output.kept.map((k) => k.id)).toEqual([101, 201, 301, 102, 501]);
    expect(r.output.kept[0]).toMatchObject({ rank: 1, finalScore: 0.83, relevanceSource: "embedding" });
    expect(r.output.kept[1]?.finalScore).toBeCloseTo(0.83, 3); // 0.86 − 0.03 — ties broken target-first
    expect(r.output.kept[3]).toMatchObject({ id: 102, finalScore: 0.7 });
  });

  it("drops nearby candidates below minNearbyRelevance but never target ones; cut rows stay in the table", async () => {
    const backend = ruhrWorld({ relevance: { 101: 0.05, 201: 0.05, 202: 0.9 } });
    const r = await rerank({ candidates: [cand(101, "Dortmund", "target", 0), cand(201, "Bochum", "nearby", 17), cand(202, "Bochum", "nearby", 17, 0.5, 1)], queryEmbedding: [1] }, ctx({ minNearbyRelevance: 0.15, topKReranked: 1 }, { backend }));
    expect(r.output.kept.map((k) => k.id)).toEqual([202]);
    const rows = Object.fromEntries(r.output.rows.map((x) => [x.id, x]));
    expect(rows[201]).toMatchObject({ kept: false, dropReason: expect.stringContaining("minNearbyRelevance"), rank: null });
    expect(rows[101]).toMatchObject({ kept: false, dropReason: expect.stringContaining("topKReranked") });
    expect(r.counts).toMatchObject({ combined: 3, duplicatesRemoved: 0, floorDropped: 1, kept: 1 });
  });

  it("falls back to the directory similarity when a stored embedding is missing", async () => {
    const backend = ruhrWorld();
    backend.getPartnerEmbeddings = async () => [];
    const r = await rerank({ candidates: [cand(101, "Dortmund", "target", 0, 0.42)], queryEmbedding: [1] }, ctx({}, { backend }));
    expect(r.output.rows[0]).toMatchObject({ relevance: 0.42, relevanceSource: "similarity", finalScore: 0.47 });
    expect(r.warnings?.[0]).toMatch(/embedding/);
  });

  it("is deterministic on ties: target first, nearer, in-city rank, id", async () => {
    const backend = ruhrWorld({ relevance: { 301: 0.5, 401: 0.5, 501: 0.5 } });
    const r = await rerank({ candidates: [cand(501, "Hagen", "nearby", 10, 0.5, 0), cand(401, "X", "nearby", 10, 0.5, 1), cand(301, "Y", "nearby", 10, 0.5, 0)], queryEmbedding: [1] }, ctx({}, { backend }));
    expect(r.output.kept.map((k) => k.id)).toEqual([301, 501, 401]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement**

```ts
/**
 * Stage 5 — Combine every city's candidates, remove duplicates, put all of
 * them on ONE relevance scale (cosine of the query embedding vs the stored
 * partner embedding), add the location term, order, cut to topKReranked.
 * `finalScore = relevance + locationTerm`. A clearly more relevant nearby
 * partner can beat a weak target-city partner; an equally relevant one cannot.
 */
import { roundScore, scoreRelevance } from "../../lib/reused/score-relevance";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { WorkflowConfig } from "../../config/workflow.config";
import type { Candidate, RankedRow, RerankOutput, StageContext, StageResult } from "../types";

export interface RerankContext extends StageContext { queryEmbedding: number[] }
export interface Reranker {
  name: string;
  rerank(candidates: Candidate[], ctx: RerankContext): Promise<{ rows: RankedRow[]; warnings: string[]; floorDropped: number }>;
}

export function combineAndDedupe(candidates: Candidate[]): { unique: Candidate[]; duplicatesRemoved: number } {
  const best = new Map<number, Candidate>();
  const better = (a: Candidate, b: Candidate) => (a.role === "target") !== (b.role === "target") ? a.role === "target" : a.distanceKm < b.distanceKm;
  for (const c of candidates) {
    const cur = best.get(c.id);
    if (!cur || better(c, cur)) best.set(c.id, c);
  }
  return { unique: [...best.values()], duplicatesRemoved: candidates.length - best.size };
}

export function locationTerm(role: "target" | "nearby", distanceKm: number, cfg: WorkflowConfig): number {
  if (role === "target") return cfg.targetCityBonus;
  const frac = Math.min(1, Math.max(0, distanceKm / cfg.searchRadiusKm));
  return -cfg.maxDistancePenalty * frac;
}

function order(a: RankedRow, b: RankedRow): number {
  return b.finalScore - a.finalScore
    || Number(b.role === "target") - Number(a.role === "target")
    || a.distanceKm - b.distanceKm
    || rankInCityOf(a) - rankInCityOf(b)
    || a.id - b.id;
}
const rankInCityMap = new WeakMap<RankedRow, number>();
const rankInCityOf = (r: RankedRow) => rankInCityMap.get(r) ?? 0;

export const embeddingReranker: Reranker = {
  name: "embedding",
  async rerank(candidates, ctx) {
    const warnings: string[] = [];
    const ids = candidates.map((c) => c.id);
    const signal = AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
    const embRows = ids.length ? await ctx.deps.backend.getPartnerEmbeddings(ids, { signal }) : [];
    const scores = scoreRelevance(ctx.queryEmbedding, new Map(embRows.map((r) => [r.id, r.embedding])));
    const missing = ids.filter((id) => !scores.has(id));
    if (missing.length) warnings.push(`${missing.length} candidate(s) have no stored embedding; using the directory similarity as relevance: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);

    let floorDropped = 0;
    const rows: RankedRow[] = candidates.map((c) => {
      const fromEmb = scores.get(c.id);
      const relevance = fromEmb ?? (c.similarity !== null ? roundScore(c.similarity) : 0);
      const relevanceSource: RankedRow["relevanceSource"] = fromEmb !== undefined ? "embedding" : c.similarity !== null ? "similarity" : "none";
      const lt = locationTerm(c.role, c.distanceKm, ctx.config);
      const row: RankedRow = {
        rank: null, id: c.id, name: c.name, city: c.city, role: c.role, distanceKm: c.distanceKm, similarity: c.similarity,
        relevance, relevanceSource, locationTerm: roundScore(lt), finalScore: roundScore(relevance + lt), kept: true,
      };
      rankInCityMap.set(row, c.rankInCity);
      if (c.role === "nearby" && relevance < ctx.config.minNearbyRelevance) {
        row.kept = false; row.dropReason = `relevance ${relevance} below minNearbyRelevance ${ctx.config.minNearbyRelevance}`; floorDropped++;
      }
      return row;
    });
    rows.sort(order);
    return { rows, warnings, floorDropped };
  },
};

const RERANKERS: Record<WorkflowConfig["reranker"], Reranker> = { embedding: embeddingReranker };

export async function rerank(input: { candidates: Candidate[]; queryEmbedding: number[] }, ctx: StageContext): Promise<StageResult<RerankOutput>> {
  const c = ctx.config;
  const { unique, duplicatesRemoved } = combineAndDedupe(input.candidates);
  const impl = RERANKERS[c.reranker];
  const { rows, warnings, floorDropped } = await impl.rerank(unique, { ...ctx, queryEmbedding: input.queryEmbedding });

  let rank = 0;
  for (const r of rows) {
    if (!r.kept) continue;
    if (rank >= c.topKReranked) { r.kept = false; r.dropReason = `beyond topKReranked ${c.topKReranked}`; continue; }
    r.rank = ++rank;
  }
  const kept = rows.filter((r) => r.kept);
  return {
    output: { reranker: impl.name, rows, kept },
    config: { reranker: c.reranker, topKReranked: c.topKReranked, targetCityBonus: c.targetCityBonus, maxDistancePenalty: c.maxDistancePenalty, minNearbyRelevance: c.minNearbyRelevance, searchRadiusKm: c.searchRadiusKm },
    counts: { combined: input.candidates.length, duplicatesRemoved, unique: unique.length, floorDropped, kept: kept.length },
    warnings,
  };
}
```
(In the "owner's example" test, C's final is 0.86 − 0.05·18/30 = 0.83 = A's 0.78 + 0.05; the tie goes to A because target-first — matching the owner's ordering A, C, D, B, E.)

- [ ] **Step 4: Run → 6 pass.** **Step 5: Commit** — `git commit -m "v3: stage 5 combine, dedupe and embedding rerank with location terms"`

---

### Task 9: Stage 6 — hydrate and answer

**Files:**
- Create: `workflow/stages/6-respond.ts`, `workflow/stages/answer-prompt.ts`
- Test: `tests/stage6-respond.test.ts`

**Interfaces:**
- Consumes: `backend.getPartnerProfiles`, `LlmPort.answer`.
- Produces: `export async function respond(input: { query: string; targetCity: string; kept: RankedRow[] }, ctx: StageContext): Promise<StageResult<RespondOutput>>`; `export function buildAnswerPrompt(args: { query: string; targetCity: string; partners: Array<{ rank: number; name: string; city: string; role: "target"|"nearby"; distanceKm: number; profile: string }> }): string`.

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { respond } from "../workflow/stages/6-respond";
import { buildAnswerPrompt } from "../workflow/stages/answer-prompt";
import { ctx, fakeLlm, profileRow, ruhrWorld } from "./_fakes";
import type { RankedRow } from "../workflow/types";

const row = (rank: number, id: number, city: string, role: "target" | "nearby", distanceKm: number): RankedRow =>
  ({ rank, id, name: `Partner ${id} (${city})`, city, role, distanceKm, similarity: 0.5, relevance: 0.8, relevanceSource: "embedding", locationTerm: 0, finalScore: 0.8, kept: true });

describe("stage 6 — respond", () => {
  it("hydrates the kept partners once, prompts with only them, returns answer + structured recommendations", async () => {
    const backend = ruhrWorld();
    const llm = fakeLlm({ answer: "**Ich habe passende Angebote gefunden.**" });
    const r = await respond({ query: "Q", targetCity: "Dortmund", kept: [row(1, 101, "Dortmund", "target", 0), row(2, 201, "Bochum", "nearby", 17.3)] }, ctx({}, { backend, llm }));
    expect(backend.callsTo("getPartnerProfiles")).toHaveLength(1);
    expect(r.output.answer).toMatch(/passende Angebote/);
    expect(r.output.recommendations.map((x) => [x.rank, x.id, x.city, x.distanceKm])).toEqual([[1, 101, "Dortmund", 0], [2, 201, "Bochum", 17.3]]);
    expect(r.output.profilesGiven).toBe(2);
    const prompt = llm.calls[0]!.arg;
    expect(prompt).toContain("Partner 101 (Dortmund)");
    expect(prompt).toContain("ca. 17 km");
    expect(prompt).not.toContain("finalScore");
  });

  it("drops a partner whose profile is missing, with a warning, without promoting the next", async () => {
    const backend = ruhrWorld();
    backend.getPartnerProfiles = async (ids) => ids.filter((id) => id !== 201).map((id) => profileRow({ partner_id: id, title: `P${id}`, city: "Dortmund", llm_profile: "text" }));
    const r = await respond({ query: "Q", targetCity: "Dortmund", kept: [row(1, 101, "Dortmund", "target", 0), row(2, 201, "Bochum", "nearby", 17)] }, ctx({}, { backend }));
    expect(r.output.recommendations.map((x) => x.id)).toEqual([101]);
    expect(r.warnings?.[0]).toMatch(/201/);
  });

  it("with no kept partners it asks the model for a polite 'nothing found' and gives it zero profiles", async () => {
    const llm = fakeLlm({ answer: "Leider nichts gefunden." });
    const r = await respond({ query: "Q", targetCity: "Dortmund", kept: [] }, ctx({}, { llm }));
    expect(r.output.recommendations).toEqual([]);
    expect(llm.calls[0]!.arg).toMatch(/keine passenden Partner/i);
  });

  it("throws when the answer model fails (runner records the stage error)", async () => {
    await expect(respond({ query: "Q", targetCity: "Dortmund", kept: [row(1, 101, "Dortmund", "target", 0)] }, ctx({}, { llm: fakeLlm({ failAnswer: new Error("model down") }) }))).rejects.toThrow("model down");
  });

  it("prompt states the honesty rules and the requested format", () => {
    const p = buildAnswerPrompt({ query: "Q", targetCity: "Dortmund", partners: [{ rank: 1, name: "A", city: "Dortmund", role: "target", distanceKm: 0, profile: "P" }] });
    for (const must of ["Dortmund", "Nur die unten aufgeführten Partner", "Keine Preise", "**1. A — Dortmund**", "Q"]) expect(p).toContain(must);
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement `workflow/stages/answer-prompt.ts`**

```ts
/** The single prompt template for the final answer. Pure; tested for its rules. */
export interface AnswerPartner { rank: number; name: string; city: string; role: "target" | "nearby"; distanceKm: number; profile: string }

export function formatLocation(p: Pick<AnswerPartner, "city" | "role" | "distanceKm">): string {
  return p.role === "target" || p.distanceKm < 1 ? p.city : `${p.city}, ca. ${Math.round(p.distanceKm)} km`;
}

export function buildAnswerPrompt(args: { query: string; targetCity: string; partners: AnswerPartner[] }): string {
  const list = args.partners.length
    ? args.partners.map((p) => `### ${p.rank}. ${p.name} — ${formatLocation(p)}\n${p.profile.trim()}`).join("\n\n")
    : "(keine passenden Partner gefunden)";
  const hasNearby = args.partners.some((p) => p.role === "nearby");
  return [
    "Du bist Navio, der freundliche Assistent von Sportnavi. Antworte auf Deutsch, per Du, knapp und hilfreich.",
    "",
    `Frage des Nutzers: "${args.query}"`,
    `Gesuchte Stadt: ${args.targetCity}${hasNearby ? " (inkl. Umgebung)" : ""}`,
    "",
    "Regeln:",
    "- Nur die unten aufgeführten Partner empfehlen — keine anderen Namen, keine erfundenen Angebote.",
    "- Keine Preise, Öffnungszeiten oder Leistungen nennen, die nicht im Profiltext stehen.",
    "- Nichts über Suchmechanik, Scores, Embeddings oder Rankings sagen.",
    "- Kontaktdaten (Website, Telefon, E-Mail) nennen, wenn sie im Profil stehen.",
    "",
    "Format:",
    `- Eine Einleitungszeile in Fett, z. B. **Ich habe passende Angebote in ${args.targetCity}${hasNearby ? " und der näheren Umgebung" : ""} gefunden.**`,
    "- Danach eine nummerierte Liste in genau dieser Reihenfolge, je Partner:",
    ...args.partners.map((p) => `  **${p.rank}. ${p.name} — ${formatLocation(p)}**  (dann 1–2 Sätze, warum dieser Partner zur Frage passt)`),
    args.partners.length ? "" : "- Wenn keine Partner aufgeführt sind: sag freundlich, dass gerade nichts Passendes gefunden wurde, und schlage vor, die Stadt oder die Sportart anders zu formulieren.",
    "",
    "Partnerprofile:",
    list,
  ].join("\n");
}
```

`workflow/stages/6-respond.ts`:
```ts
/**
 * Stage 6 — Hydrate the kept partners' profiles (one batched call) and let
 * the model phrase the answer from those profiles ONLY. A missing profile
 * drops that partner (the cut was fixed in stage 5, so UI and answer agree).
 */
import { timeoutSignal } from "../../lib/reused/timeout";
import { buildAnswerPrompt, type AnswerPartner } from "./answer-prompt";
import type { RankedRow, Recommendation, RespondOutput, StageContext, StageResult } from "../types";

export async function respond(input: { query: string; targetCity: string; kept: RankedRow[] }, ctx: StageContext): Promise<StageResult<RespondOutput>> {
  const warnings: string[] = [];
  const signal = () => AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
  const ids = input.kept.map((r) => r.id);
  const profiles = ids.length ? await ctx.deps.backend.getPartnerProfiles(ids, { signal: signal() }) : [];
  const byId = new Map(profiles.map((p) => [p.partner_id, p]));

  const partners: AnswerPartner[] = [];
  const recommendations: Recommendation[] = [];
  for (const r of input.kept) {
    const p = byId.get(r.id);
    const profile = p?.llm_profile?.trim() || p?.body_markdown?.trim() || "";
    if (!p || !profile) { warnings.push(`Partner ${r.id} (${r.name}) has no profile text and was dropped from the answer.`); continue; }
    const rank = r.rank ?? partners.length + 1;
    partners.push({ rank, name: p.title || r.name, city: p.city || r.city, role: r.role, distanceKm: r.distanceKm, profile });
    recommendations.push({ rank, id: r.id, name: p.title || r.name, city: p.city || r.city, role: r.role, distanceKm: r.distanceKm, finalScore: r.finalScore, relevance: r.relevance, profile });
  }

  const prompt = buildAnswerPrompt({ query: input.query, targetCity: input.targetCity, partners });
  const answer = (await ctx.deps.llm.answer(prompt, { signal: signal() })).trim();

  return {
    output: { answer, recommendations, profilesGiven: partners.length, model: ctx.deps.llm.modelName },
    config: {},
    counts: { kept: input.kept.length, profilesFound: profiles.length, recommended: recommendations.length, promptChars: prompt.length },
    warnings,
  };
}
```

- [ ] **Step 4: Run → 5 pass.** **Step 5: Commit** — `git commit -m "v3: stage 6 hydrate profiles and generate the answer"`

---

### Task 10: The runner, the real deps, and the CLI

**Files:**
- Create: `workflow/run-workflow.ts`, `workflow/deps.ts`, `lib/llm-port.ts` (add `createAzureLlmPort`), `scripts/run.ts`
- Test: `tests/run-workflow.test.ts`

**Interfaces:**
- Produces: `export async function runWorkflow(input: WorkflowInput, overrides?: Partial<WorkflowConfig>, deps?: WorkflowDeps): Promise<WorkflowTrace>`; `export function createDeps(): WorkflowDeps`; `export function createAzureLlmPort(): LlmPort`.

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";
import { deps, fakeEmbed, fakeLlm, ruhrWorld } from "./_fakes";

const Q = "Ich suche einen Sportverein in Dortmund, der mir nach meiner Knieverletzung beim Wiedereinstieg ins Training helfen kann.";
const happy = () => deps({ llm: fakeLlm({ cityMention: "Dortmund", reformulated: "Reha-Sport Dortmund Knie", answer: "**Gefunden.**" }) });

describe("runWorkflow", () => {
  it("runs all six stages in order and returns answer + recommendations", async () => {
    const t = await runWorkflow({ query: Q }, { maxNearbyHubs: 0 }, happy());
    expect(t.status).toBe("ok");
    expect(t.stages.map((s) => [s.id, s.status])).toEqual([
      ["detect-city", "ok"], ["reformulate", "ok"], ["nearby-cities", "ok"], ["search", "ok"], ["rerank", "ok"], ["respond", "ok"],
    ]);
    expect(t.answer).toBe("**Gefunden.**");
    expect(t.recommendations?.length).toBe(5);
    expect(t.config.topKReranked).toBe(5);
    expect(t.totalMs).toBeGreaterThanOrEqual(0);
    for (const s of t.stages) expect(s.durationMs).toBeGreaterThanOrEqual(0);
    expect((t.stages[3]!.output as { retrievalQuery: string }).retrievalQuery).toBe("Reha-Sport Dortmund Knie");
  });

  it("stops with needs_clarification when no city resolves; later stages are skipped", async () => {
    const t = await runWorkflow({ query: "Ich suche Yoga" }, {}, deps({ llm: fakeLlm({ cityMention: null }) }));
    expect(t.status).toBe("needs_clarification");
    expect(t.clarification).toMatch(/Stadt/);
    expect(t.stages[0]!.status).toBe("warning");
    expect(t.stages.slice(1).every((s) => s.status === "skipped")).toBe(true);
    expect(t.stages).toHaveLength(6);
  });

  it("records a stage error and skips the rest when the embedding fails", async () => {
    const t = await runWorkflow({ query: Q }, {}, deps({ llm: fakeLlm({ cityMention: "Dortmund" }), embed: fakeEmbed(undefined, new Error("embed down")) }));
    expect(t.status).toBe("failed");
    expect(t.stages[3]).toMatchObject({ id: "search", status: "error", error: { message: "embed down" } });
    expect(t.stages[4]!.status).toBe("skipped");
    expect(t.stages[5]!.status).toBe("skipped");
  });

  it("marks a stage 'warning' when it has warnings, and echoes the effective config", async () => {
    const t = await runWorkflow({ query: Q }, { searchRadiusKm: 60, maxNearbyHubs: 0 }, deps({ llm: fakeLlm({ cityMention: "Dortmund" }), backend: ruhrWorld({ failCities: ["Bochum"] }) }));
    expect(t.stages[3]!.status).toBe("warning");
    expect(t.config.searchRadiusKm).toBe(60);
  });

  it("returns a failed trace (not a throw) on an invalid config", async () => {
    const t = await runWorkflow({ query: Q }, { topKSimilarity: 99 }, happy());
    expect(t.status).toBe("failed");
    expect(t.stages).toEqual([]);
    expect(t.clarification).toBeUndefined();
    expect((t as { error?: { message: string } }).error?.message).toMatch(/topKSimilarity/);
  });

  it("a run deadline surfaces as that stage's error", async () => {
    const slow = ruhrWorld();
    slow.resolveCityFuzzy = () => new Promise(() => {});
    const t = await runWorkflow({ query: Q }, { runTimeoutMs: 1000, callTimeoutMs: 100 }, deps({ llm: fakeLlm({ cityMention: "Dortmund" }), backend: slow }));
    expect(t.status).toBe("needs_clarification"); // resolve timed out → attempt rejected → no city
    expect(t.stages[0]!.output).toMatchObject({ attempts: [{ accepted: false, reason: expect.stringMatching(/abort|timeout/i) }] });
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement `workflow/run-workflow.ts`**

```ts
/**
 * workflow/run-workflow.ts — the sequential runner.
 * Six stages, strictly in order. Each becomes a StageRecord in the trace
 * (input, output, config used, filters, counts, warnings, error, duration).
 * The runner NEVER throws: a stage error stops the run with status "failed",
 * later stages are recorded as "skipped".
 */
import { randomUUID } from "node:crypto";
import { resolveConfig, type WorkflowConfig } from "../config/workflow.config";
import { detectCity } from "./stages/1-detect-city";
import { reformulate } from "./stages/2-reformulate";
import { nearbyCities } from "./stages/3-nearby-cities";
import { search } from "./stages/4-search";
import { rerank } from "./stages/5-rerank";
import { respond } from "./stages/6-respond";
import type { StageContext, StageId, StageRecord, StageResult, WorkflowDeps, WorkflowInput, WorkflowTrace } from "./types";

const TITLES: Record<StageId, string> = {
  "detect-city": "Detect city", reformulate: "Reformulate question", "nearby-cities": "Find nearby cities",
  search: "Embed once + similarity search", rerank: "Combine, dedupe, rerank", respond: "Final response",
};
const ORDER: StageId[] = ["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"];

export const CLARIFICATION = "In welcher Stadt (oder Umgebung) suchst du? Sag mir kurz den Ort, dann finde ich passende Angebote.";

function skipped(id: StageId): StageRecord {
  return { id, title: TITLES[id], status: "skipped", durationMs: 0, input: null, config: {}, warnings: [] };
}

async function runStage<I, O>(id: StageId, input: I, fn: () => Promise<StageResult<O>>): Promise<{ record: StageRecord<I, O>; result?: StageResult<O> }> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const warnings = result.warnings ?? [];
    return {
      record: {
        id, title: TITLES[id], status: warnings.length ? "warning" : "ok", durationMs: Math.round(performance.now() - t0),
        input, output: result.output, config: result.config, ...(result.filters ? { filters: result.filters } : {}), ...(result.counts ? { counts: result.counts } : {}), warnings,
      },
      result,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { record: { id, title: TITLES[id], status: "error", durationMs: Math.round(performance.now() - t0), input, config: {}, warnings: [], error: { message } } };
  }
}

export async function runWorkflow(input: WorkflowInput, overrides: Partial<WorkflowConfig> = {}, deps?: WorkflowDeps): Promise<WorkflowTrace> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const runId = randomUUID();
  const done = (partial: Partial<WorkflowTrace> & { status: WorkflowTrace["status"]; config: WorkflowConfig; stages: StageRecord[] }): WorkflowTrace =>
    ({ runId, startedAt, totalMs: Math.round(performance.now() - t0), input, ...partial });

  let config: WorkflowConfig;
  try {
    config = resolveConfig(overrides);
  } catch (e) {
    return { ...done({ status: "failed", config: { ...(overrides as WorkflowConfig) }, stages: [] }), error: { message: (e as Error).message } } as WorkflowTrace;
  }
  const d = deps ?? (await import("./deps")).createDeps();
  const ctx: StageContext = { config, deps: d, signal: AbortSignal.timeout(config.runTimeoutMs) };
  const stages: StageRecord[] = [];
  const skipRest = () => { for (const id of ORDER.slice(stages.length)) stages.push(skipped(id)); };

  // 1
  const s1 = await runStage("detect-city", { query: input.query, homeCity: input.homeCity, sessionCities: input.sessionCities }, () => detectCity(input, ctx));
  stages.push(s1.record);
  if (!s1.result) { skipRest(); return done({ status: "failed", config, stages }); }
  const target = s1.result.output.target;
  if (!target) { skipRest(); return done({ status: "needs_clarification", config, stages, clarification: CLARIFICATION }); }

  // 2
  const s2 = await runStage("reformulate", { query: input.query }, () => reformulate({ query: input.query }, ctx));
  stages.push(s2.record);
  if (!s2.result) { skipRest(); return done({ status: "failed", config, stages }); }
  const retrievalQuery = s2.result.output.retrievalQuery;

  // 3
  const s3 = await runStage("nearby-cities", { target: target.canonical, centroid: target.centroid }, () => nearbyCities({ target }, ctx));
  stages.push(s3.record);
  if (!s3.result) { skipRest(); return done({ status: "failed", config, stages }); }
  const cities = s3.result.output.cities;

  // 4
  let queryEmbedding: number[] = [];
  const s4 = await runStage("search", { retrievalQuery, cities: cities.map((c) => c.city) }, async () => {
    const r = await search({ retrievalQuery, cities }, ctx);
    queryEmbedding = r.queryEmbedding;
    return r;
  });
  stages.push(s4.record);
  if (!s4.result) { skipRest(); return done({ status: "failed", config, stages }); }

  // 5
  const candidates = s4.result.output.candidates;
  const s5 = await runStage("rerank", { candidates: candidates.length }, () => rerank({ candidates, queryEmbedding }, ctx));
  stages.push(s5.record);
  if (!s5.result) { skipRest(); return done({ status: "failed", config, stages }); }

  // 6
  const kept = s5.result.output.kept;
  const s6 = await runStage("respond", { query: input.query, targetCity: target.canonical, kept: kept.map((k) => k.id) }, () => respond({ query: input.query, targetCity: target.canonical, kept }, ctx));
  stages.push(s6.record);
  if (!s6.result) return done({ status: "failed", config, stages });

  return done({ status: "ok", config, stages, answer: s6.result.output.answer, recommendations: s6.result.output.recommendations });
}
```
Add `error?: { message: string }` to `WorkflowTrace` in `workflow/types.ts` (config failure) and remove the `as WorkflowTrace` cast accordingly.

- [ ] **Step 4: Add `createAzureLlmPort` to `lib/llm-port.ts`**

Append:
```ts
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getAzureChatModel } from "./reused/llm";

const citySchema = z.object({
  cityMention: z.string().nullable().describe("The city/town/place the user wants to train in, VERBATIM as written (may be misspelled). null if no location is mentioned."),
});

export function createAzureLlmPort(): LlmPort {
  const model = getAzureChatModel();
  const modelName = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "azure";
  return {
    modelName,
    async detectCity(query, { signal }) {
      const { object } = await generateObject({
        model, schema: citySchema, abortSignal: signal, temperature: 0,
        system: "Extract only the location the user wants to train in. Do not guess a city that is not in the text. Words like 'in meiner Nähe' or 'hier' are NOT a city.",
        prompt: query,
      });
      return { cityMention: object.cityMention?.trim() || null };
    },
    async reformulate(query, { maxChars, signal }) {
      const { text } = await generateText({
        model, abortSignal: signal, temperature: 0.2,
        system: [
          "Du formulierst Nutzerfragen in eine ausführlichere, semantisch reichhaltige Suchanfrage für eine Vektorsuche über Sport-, Gesundheits- und Therapieangebote um.",
          "Behalte die Absicht des Nutzers exakt bei: die gesuchte Sportart/Leistung, das gesundheitliche Anliegen, Vorlieben und Einschränkungen und den Ort.",
          "Ergänze passende Synonyme und typische Angebotsbezeichnungen (z. B. Reha-Sport, Physiotherapie, Kurse, Training), aber erfinde keine Fakten.",
          `Antworte NUR mit der Suchanfrage: ein Absatz, Deutsch, maximal ${maxChars} Zeichen, keine Anrede, keine Erklärung, keine Anführungszeichen.`,
        ].join(" "),
        prompt: query,
      });
      return text.trim();
    },
    async answer(prompt, { signal }) {
      const { text } = await generateText({ model, abortSignal: signal, temperature: 0.3, prompt });
      return text;
    },
  };
}
```

- [ ] **Step 5: Write `workflow/deps.ts` and `scripts/run.ts`**

`workflow/deps.ts`:
```ts
/** The real ports: Supabase facade, the pinned embedding endpoint, Azure chat model. */
import { getSupabase } from "../lib/reused/supabase";
import { embedText } from "../lib/reused/embeddings";
import { createAzureLlmPort } from "../lib/llm-port";
import type { WorkflowDeps } from "./types";

let cached: WorkflowDeps | undefined;
export function createDeps(): WorkflowDeps {
  cached ??= { backend: getSupabase(), embed: embedText, llm: createAzureLlmPort() };
  return cached;
}
```

`scripts/run.ts`:
```ts
import "../lib/reused/load-env";
import { runWorkflow } from "../workflow/run-workflow";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('usage: npm run workflow -- "Ich suche Physiotherapie in Bochum" [--home Dortmund] [--radius 30]');
  process.exit(1);
}
const homeIdx = process.argv.indexOf("--home");
const radiusIdx = process.argv.indexOf("--radius");
const trace = await runWorkflow(
  { query: query.replace(/--home \S+|--radius \S+/g, "").trim(), homeCity: homeIdx > 0 ? process.argv[homeIdx + 1] : undefined },
  radiusIdx > 0 ? { searchRadiusKm: Number(process.argv[radiusIdx + 1]) } : {},
);
for (const s of trace.stages) {
  console.log(`\n[${s.status.toUpperCase()}] ${s.title} (${s.durationMs} ms)`);
  if (s.counts) console.log("  counts:", JSON.stringify(s.counts));
  for (const w of s.warnings) console.log("  ⚠", w);
  if (s.error) console.log("  ✖", s.error.message);
}
console.log(`\nstatus: ${trace.status} · ${trace.totalMs} ms`);
if (trace.clarification) console.log(trace.clarification);
if (trace.answer) console.log("\n" + trace.answer);
if (process.argv.includes("--json")) console.log(JSON.stringify(trace, null, 2));
```

- [ ] **Step 6: Run** — `npm test` → all pass; `npm run typecheck` clean. Then, with `.env.local` copied from V2 (`Copy-Item ..\partner-recommendation-agent-v2\.env.local .env.local`), a live check:
```powershell
npm run workflow -- "Ich suche einen Sportverein in Dortmund, der mir nach meiner Knieverletzung beim Wiedereinstieg ins Training helfen kann."
```
Expected: six `[OK]`/`[WARNING]` lines, `status: ok`, a German answer listing ≤ 5 partners with cities and "ca. N km" for nearby ones. If `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` in the copied env is `gpt-4o-mini`, that is fine for the lab.

- [ ] **Step 7: Commit** — `git commit -m "v3: sequential runner, Azure LLM port, real deps and CLI"`

---

### Task 11: API route

**Files:**
- Create: `app/api/workflow/route.ts`, `app/layout.tsx`, `app/globals.css` (minimal, so `next dev` boots), `next-env.d.ts` is generated
- Test: `tests/api-route.test.ts`

**Interfaces:**
- Produces: `POST /api/workflow` `{ query, homeCity?, sessionCities?, config? }` → `WorkflowTrace` (200) or `{ error }` (400); `GET /api/workflow` → `{ defaults: WorkflowConfig, envSet: string[] }`.

- [ ] **Step 1: Test** (`tests/api-route.test.ts`) — mock the runner:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../workflow/run-workflow", () => ({
  runWorkflow: vi.fn(async (input, overrides) => ({ runId: "r", startedAt: "", totalMs: 1, status: "ok", input, config: overrides, stages: [] })),
}));
const { GET, POST } = await import("../app/api/workflow/route");

describe("POST /api/workflow", () => {
  it("400 on an invalid body", async () => {
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "" }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/query/);
  });
  it("200 with the trace, passing overrides through", async () => {
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "Yoga in Bochum", homeCity: "Essen", config: { searchRadiusKm: 12 } }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.input).toEqual({ query: "Yoga in Bochum", homeCity: "Essen", sessionCities: undefined });
    expect(body.config).toEqual({ searchRadiusKm: 12 });
  });
  it("GET returns defaults", async () => {
    const body = await (await GET()).json();
    expect(body.defaults.topKReranked).toBe(5);
    expect(Array.isArray(body.envSet)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `app/api/workflow/route.ts`**

```ts
import { z } from "zod";
import { loadConfigFromEnv } from "../../../config/workflow.config";
import { runWorkflow } from "../../../workflow/run-workflow";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2000),
  homeCity: z.string().trim().max(100).optional(),
  sessionCities: z.array(z.string().trim().max(100)).max(20).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  const { query, homeCity, sessionCities, config } = parsed.data;
  const trace = await runWorkflow({ query, homeCity: homeCity || undefined, sessionCities }, (config ?? {}) as Parameters<typeof runWorkflow>[1]);
  return Response.json(trace);
}

export async function GET(): Promise<Response> {
  const { config, envSet } = loadConfigFromEnv();
  return Response.json({ defaults: config, envSet });
}
```

`app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Partner Retrieval V3 — Workflow Lab", description: "Stage-by-stage debug UI for the V3 partner-retrieval workflow." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
```
`app/globals.css`: `@import "tailwindcss";`

- [ ] **Step 3: Run** — `npm test` green. `npm run dev -- -p 3008` then in another shell:
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3008/api/workflow -ContentType application/json -Body '{"query":"Yoga in Bochum"}' | ConvertTo-Json -Depth 3 | Select-Object -First 40
```
Expected: JSON with `status: ok` and six stages. Stop the server (kill by port 3008).

- [ ] **Step 4: Commit** — `git commit -m "v3: POST /api/workflow route and Next.js shell"`

---

### Task 12: Developer UI

**Files:**
- Create: `app/page.tsx`, `components/QueryForm.tsx`, `components/ConfigPanel.tsx`, `components/StageSection.tsx`, `components/JsonBlock.tsx`, `components/stages/DetectCityView.tsx`, `components/stages/ReformulateView.tsx`, `components/stages/NearbyCitiesView.tsx`, `components/stages/SearchView.tsx`, `components/stages/RerankView.tsx`, `components/stages/RespondView.tsx`, `components/RunHistory.tsx`, `lib/ui/examples.ts`, `lib/ui/format.ts`
- Test: `tests/ui-format.test.ts` (pure helpers only; components are checked in the browser)

**Interfaces:**
- Consumes: `WorkflowTrace`, `StageRecord`, the stage output types, `WorkflowConfig`, `GET/POST /api/workflow`.
- Produces: `lib/ui/format.ts` → `fmtScore(n: number | null | undefined): string` (4 dp or "—"), `fmtKm(n): string` ("0 km" / "17.3 km"), `statusColor(status): string` (Tailwind classes), `EXAMPLE_QUERIES: string[]`.

- [ ] **Step 1: Helpers + test**

`lib/ui/examples.ts`:
```ts
export const EXAMPLE_QUERIES = [
  "Ich suche einen Sportverein in Dortmund, der mir nach meiner Knieverletzung beim Wiedereinstieg ins Training helfen kann.",
  "Ich suche ein Physiotherapie-Studio in Berlin.",
  "Ich habe Rückenschmerzen und suche etwas in Bochum.",
  "Ich möchte in der Nähe von Dortmund Tennis spielen.",
  "Ich brauche Physiotherapie für meinen Rücken irgendwo um Bochum.",
  "Yoga in Bochum",
];
```
`lib/ui/format.ts`:
```ts
import type { StageStatus, WorkflowStatus } from "../../workflow/types";
export const fmtScore = (n: number | null | undefined): string => (typeof n === "number" ? n.toFixed(4) : "—");
export const fmtKm = (n: number): string => (n < 0.05 ? "0 km" : `${Math.round(n * 10) / 10} km`);
export function statusColor(s: StageStatus | WorkflowStatus): string {
  switch (s) {
    case "ok": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "warning": case "needs_clarification": return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "error": case "failed": return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
    default: return "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  }
}
```
`tests/ui-format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fmtKm, fmtScore, statusColor } from "../lib/ui/format";
describe("ui format", () => {
  it("formats", () => {
    expect(fmtScore(0.83)).toBe("0.8300"); expect(fmtScore(null)).toBe("—");
    expect(fmtKm(0)).toBe("0 km"); expect(fmtKm(17.26)).toBe("17.3 km");
    expect(statusColor("error")).toMatch(/red/); expect(statusColor("skipped")).toMatch(/zinc/);
  });
});
```

- [ ] **Step 2: Generic building blocks**

`components/JsonBlock.tsx`:
```tsx
"use client";
export function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <details className="rounded border border-zinc-200 dark:border-zinc-800">
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</summary>
      <pre className="max-h-96 overflow-auto px-3 py-2 text-xs leading-5">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
```
`components/StageSection.tsx`:
```tsx
"use client";
import { useState } from "react";
import type { StageRecord } from "../workflow/types";
import { statusColor } from "../lib/ui/format";
import { JsonBlock } from "./JsonBlock";

export function StageSection({ index, stage, children }: { index: number; stage: StageRecord; children?: React.ReactNode }) {
  const [open, setOpen] = useState(stage.status !== "skipped");
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="text-zinc-400">{open ? "▼" : "▶"}</span>
        <span className="font-semibold">{index}. {stage.title}</span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusColor(stage.status)}`}>{stage.status}</span>
        <span className="ml-auto text-xs text-zinc-500">{stage.durationMs} ms</span>
      </button>
      {open && stage.status !== "skipped" && (
        <div className="space-y-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {stage.error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">✖ {stage.error.message}</p>}
          {stage.warnings.length > 0 && (
            <ul className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {stage.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
            </ul>
          )}
          {stage.counts && (
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(stage.counts).map(([k, v]) => <span key={k} className="rounded bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">{k}: <b>{v}</b></span>)}
            </div>
          )}
          {children}
          <div className="grid gap-2 md:grid-cols-2">
            <JsonBlock label="Input" value={stage.input} />
            <JsonBlock label="Output (raw)" value={stage.output} />
            <JsonBlock label="Config used" value={stage.config} />
            <JsonBlock label="Filters" value={stage.filters} />
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Stage views** (`components/stages/*.tsx`, all `"use client"`, each takes `{ output }` typed with the matching stage output type from `workflow/types.ts`):

`DetectCityView.tsx` — heading line `Target city: <canonical> (source: <source>, confidence <n>)` or "No city determined"; a table of `attempts` with columns Source · Mention · Resolved · Confidence · Accepted · Reason.

`ReformulateView.tsx` — two side-by-side boxes "Original query" / "Retrieval query" and a line `Reformulated: Yes/No · model`.

`NearbyCitiesView.tsx` — table City · Role · Distance (`fmtKm`) · Partners in directory; target row bold.

`SearchView.tsx` — line `Embedding: <model>, <dimensions> dims, preview [..]`; then one `<details open>` per `perCity` entry titled `<city> (<role>, <fmtKm>) — requested <n>, returned <n>, kept <n>` (red "failed: msg" when present) with a table Rank · Partner · Similarity (`fmtScore`).

`RerankView.tsx` — one table over `output.rows` with columns Rank · Partner · City · Role · Distance · Similarity · Relevance (+source badge `emb`/`sim`) · Location term · **Final score** · Kept/Drop reason; kept rows normal, dropped rows `opacity-50` with the reason; a client-side sort by any numeric column (state `sortKey`, default `finalScore` desc). Header line `Reranker: <name>`.

`RespondView.tsx` — the answer rendered with `react-markdown` inside a bordered card; below it a table of `recommendations` (Rank · Partner · City · Distance · Final score · Relevance) and a `<details>` per recommendation with the profile text the model was given; line `Profiles given to the model: <n> · model`.

- [ ] **Step 4: Query form, config panel, run history**

`components/QueryForm.tsx` — props `{ query, setQuery, homeCity, setHomeCity, running, onRun }`: a `<textarea>` (3 rows), an input "Home city (fallback when no city is mentioned)", chips for `EXAMPLE_QUERIES` that set the query, a Run button (disabled while running or empty), Ctrl/Cmd+Enter runs.

`components/ConfigPanel.tsx` — props `{ defaults: WorkflowConfig, envSet: string[], overrides: Partial<WorkflowConfig>, setOverrides }`: a collapsible panel listing every key of `defaults` except `reranker` (shown as read-only "embedding") in a 3-column grid; numbers as `<input type="number" step="any">`, booleans as checkboxes, `targetCity` as a text input; placeholder = default, an "env" badge when `envSet` contains the key; changing a field writes the override (empty ⇒ delete the key); "Reset to defaults" clears overrides. Values shown are `overrides[k] ?? defaults[k]`.

`components/RunHistory.tsx` — props `{ runs: WorkflowTrace[], selected: string | undefined, onSelect }`: a horizontal list of up to 10 chips `HH:MM:SS · status · totalMs · query (first 40 chars)`; clicking selects that trace.

- [ ] **Step 5: The page** `app/page.tsx`

```tsx
"use client";
import { useEffect, useState } from "react";
import type { WorkflowConfig } from "../config/workflow.config";
import type { DetectCityOutput, NearbyCitiesOutput, ReformulateOutput, RerankOutput, RespondOutput, SearchOutput, WorkflowTrace } from "../workflow/types";
import { statusColor } from "../lib/ui/format";
import { QueryForm } from "../components/QueryForm";
import { ConfigPanel } from "../components/ConfigPanel";
import { StageSection } from "../components/StageSection";
import { RunHistory } from "../components/RunHistory";
import { DetectCityView } from "../components/stages/DetectCityView";
import { ReformulateView } from "../components/stages/ReformulateView";
import { NearbyCitiesView } from "../components/stages/NearbyCitiesView";
import { SearchView } from "../components/stages/SearchView";
import { RerankView } from "../components/stages/RerankView";
import { RespondView } from "../components/stages/RespondView";

export default function Page() {
  const [defaults, setDefaults] = useState<WorkflowConfig | null>(null);
  const [envSet, setEnvSet] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Partial<WorkflowConfig>>({});
  const [query, setQuery] = useState("");
  const [homeCity, setHomeCity] = useState("");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<WorkflowTrace[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workflow").then((r) => r.json()).then((b) => { setDefaults(b.defaults); setEnvSet(b.envSet); }).catch((e) => setFetchError(String(e)));
  }, []);

  async function run() {
    setRunning(true); setFetchError(null);
    try {
      const res = await fetch("/api/workflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, homeCity: homeCity || undefined, config: overrides }) });
      const body = await res.json();
      if (!res.ok) { setFetchError(body.error ?? `HTTP ${res.status}`); return; }
      const trace = body as WorkflowTrace;
      setRuns((r) => [trace, ...r].slice(0, 10));
      setSelected(trace.runId);
    } catch (e) { setFetchError(String(e)); } finally { setRunning(false); }
  }

  const trace = runs.find((r) => r.runId === selected);
  const out = <T,>(id: string) => trace?.stages.find((s) => s.id === id)?.output as T | undefined;

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Partner Retrieval V3 — Workflow Lab</h1>
        <span className="text-xs text-zinc-500">Detect city → Reformulate → Nearby cities → Embed once + search → Rerank → Answer</span>
      </header>
      <QueryForm query={query} setQuery={setQuery} homeCity={homeCity} setHomeCity={setHomeCity} running={running} onRun={run} />
      {defaults && <ConfigPanel defaults={defaults} envSet={envSet} overrides={overrides} setOverrides={setOverrides} />}
      {fetchError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{fetchError}</p>}
      <RunHistory runs={runs} selected={selected} onSelect={setSelected} />
      {trace && (
        <>
          <div className="flex items-center gap-3 text-sm">
            <span className={`rounded px-2 py-0.5 font-medium ${statusColor(trace.status)}`}>{trace.status}</span>
            <span>{trace.totalMs} ms</span>
            {trace.clarification && <span className="text-amber-700">{trace.clarification}</span>}
            {trace.error && <span className="text-red-700">{trace.error.message}</span>}
            <button type="button" className="ml-auto rounded border px-2 py-0.5 text-xs" onClick={() => navigator.clipboard.writeText(JSON.stringify(trace, null, 2))}>Copy trace JSON</button>
          </div>
          {trace.stages.map((s, i) => (
            <StageSection key={s.id} index={i + 1} stage={s}>
              {s.id === "detect-city" && s.output && <DetectCityView output={out<DetectCityOutput>(s.id)!} />}
              {s.id === "reformulate" && s.output && <ReformulateView output={out<ReformulateOutput>(s.id)!} />}
              {s.id === "nearby-cities" && s.output && <NearbyCitiesView output={out<NearbyCitiesOutput>(s.id)!} />}
              {s.id === "search" && s.output && <SearchView output={out<SearchOutput>(s.id)!} />}
              {s.id === "rerank" && s.output && <RerankView output={out<RerankOutput>(s.id)!} />}
              {s.id === "respond" && s.output && <RespondView output={out<RespondOutput>(s.id)!} />}
            </StageSection>
          ))}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Verify in the browser**

`npm run typecheck` clean; `npm test` green. `npm run dev -- -p 3008`, open <http://localhost:3008>, click the first example chip, Run. Check: six sections appear in order; Detect City shows "Dortmund / explicit"; Reformulate shows two different texts and "Reformulated: Yes"; Nearby Cities lists Dortmund first at 0 km; Similarity Search shows one embedding line and one table per city; Rerank shows the full table with dimmed cut rows; Final Response renders the German answer with ≤ 5 partners. Then: set `enableQueryReformulation` off in the config panel → re-run → "Reformulated: No" and retrieval query = original. Then run "Ich suche Yoga" with an empty home city → status `needs_clarification`, stages 2–6 skipped; with home city "Bochum" → runs. Use the `browse` skill or a manual check; fix anything that renders wrong. Kill the server by port when done.

- [ ] **Step 7: Commit** — `git commit -m "v3: developer UI with per-stage collapsible trace, config panel and run history"`

---

### Task 13: README, memory note, final verification

**Files:**
- Create: `README.md`
- Modify: `C:\Users\moham\.claude\projects\c--Users-moham-Documents-GitHub-CortexKit\memory\partner-agent-v2.md` (add a V3 pointer) and `MEMORY.md` index line (memory dir, not the repo)

- [ ] **Step 1: Write `README.md`** covering: purpose (lab for the new retrieval strategy; independent of the live agents); the six-stage diagram (copy the "In short" line); how to run (`npm install`, copy `.env.local` from V2, `npm run dev -- -p 3008`, `npm run workflow -- "…"`); the config table (§5 of the spec, with env names); how the rerank formula works with the owner's worked example (A 0.83 · C 0.83 · D 0.785 · B 0.70 · E 0.687 — computed with radius 30, bonus/penalty 0.05); what the UI shows per stage; error semantics (warnings vs errors vs needs_clarification); the reuse rule (`lib/reused/` copies, never imports); limits (no auth on the route, not deployed, no Langfuse, embedding reranker only, single request per message); port map.

- [ ] **Step 2: Memory** — append to the memory dir's `partner-agent-v2.md` a paragraph "V3 (2026-09-14): `partner-recommendation-agent-v3/` — sequential lab pipeline + `/api/workflow` + stage-by-stage dev UI on port 3008; not an eve agent; see spec `docs/superpowers/specs/2026-09-14-partner-retrieval-v3-design.md`", and update its index line in `MEMORY.md` to mention V3 and port 3008.

- [ ] **Step 3: Final verification** from the V3 folder: `npm run typecheck` (clean), `npm test` (all suites green — report the count), `npm run workflow -- "Yoga in Bochum"` (status ok). From the CortexKit root: `git status` must show changes only under `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/` and `docs/superpowers/`. Confirm V2 and the live agents are untouched: `git status --porcelain SportnaviPartnerRecomandationBot/partner-recommendation-agent-supabase SportnaviPartnerRecomandationBot/partner-recommendation-agent-convex` is empty (V2 is untracked already — do not add it in these commits).

- [ ] **Step 4: Commit** — `git commit -m "v3: README and verification"`

---

## Self-review notes

- Spec coverage: §3 layout → T1/T10–12; §4 stages 1–6 → T4–T9; runner semantics → T10; §5 config → T2 (+ UI in T12); §6 API → T11; §7 UI → T12 (all listed views, config panel, history, copy JSON); §8 tests → each task; §9 out-of-scope respected.
- `WorkflowTrace.error` is introduced in T10 — add it to `workflow/types.ts` there (noted in T10 step 3).
- `search()` returns `queryEmbedding` beside the `StageResult`; the runner captures it in a closure (T10) — consistent with T7.
- `rerank()` consumes `Candidate[]` from T7's `output.candidates` and `RankedRow.rank` is `null` for cut rows — T9 handles `rank ?? index`.
