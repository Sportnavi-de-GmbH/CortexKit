# Partner Retrieval Workflow V3 — design

**Date:** 2026-09-14 · **Status:** approved by owner (chat) · **Location:**
`SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/`

## 1. Purpose

A new, independent project to test an improved retrieval strategy for "find me a sport /
health / therapy offer in <city>" questions. It is a **sequential, deterministic pipeline** with
a **developer UI** that shows every stage, so runs can be inspected and compared. It does not
replace, modify or import from the existing agents (`-supabase` live, `-convex` reference, `-v2`).

The pipeline, in the owner's words:

> Detect city → Reformulate query → Find nearby cities → Embed reformulated query once →
> Similarity search across target + nearby cities → Combine + dedupe → Rerank → Final
> recommendations.

## 2. Decisions taken with the owner

| Question | Decision |
|---|---|
| "Home city" | An explicit workflow input (`homeCity`, from the dev UI now, the widget later) plus a session fallback (`sessionCities`: cities resolved earlier in the conversation, most recent first). **No geolocation.** |
| Runtime shape | Pure TypeScript pipeline behind a Next.js API route, consumed by the dev UI. No eve agent / tool loop in this iteration (can be wrapped later). |
| Retrieval | One embedding of the **reformulated** query; parallel per-city `match_partners` calls (the RPC filters on one city per call); union → dedupe → rerank globally. |
| Reformulation | Always on by default (`enableQueryReformulation`), producing a richer German search query that preserves intent, service, health need, preferences and constraints. Off ⇒ `retrievalQuery = originalUserQuery`. |
| Reranker | Embedding-based: `finalScore = relevance + targetCityBonus − distancePenalty`. Behind a small interface so an LLM reranker can be added as a config switch later. |

## 3. Project layout

```
partner-recommendation-agent-v3/
├── README.md
├── package.json              next 15 · react 19 · ai 7 · @ai-sdk/openai · @supabase/supabase-js · zod · vitest · tsx
├── .env.local.example        same variable names as V2 (Azure, MEMORY_SUPABASE_*, EMBEDDING_*)
├── config/workflow.config.ts every dial + env loading + per-request override merge
├── workflow/
│   ├── types.ts              WorkflowInput, WorkflowConfig-facing types, StageRecord, WorkflowTrace
│   ├── run-workflow.ts       the sequential runner (records every stage, stops on failure)
│   └── stages/
│       ├── 1-detect-city.ts
│       ├── 2-reformulate.ts
│       ├── 3-nearby-cities.ts
│       ├── 4-search.ts       embed once + per-city similarity search
│       ├── 5-rerank.ts       combine · dedupe · score · order · top K
│       └── 6-respond.ts      hydrate profiles + generate the answer
├── lib/reused/               UNCHANGED copies from V2 (headers name the source):
│                             supabase.ts · embeddings.ts · score-relevance.ts · llm.ts ·
│                             load-env.ts · timeout.ts · cache.ts · nearby-cities.ts · limiter.ts
├── app/
│   ├── layout.tsx, globals.css, page.tsx           the developer UI
│   └── api/workflow/route.ts                        POST → WorkflowTrace; GET → defaults
├── components/               QueryForm · ConfigPanel · StageSection · tables · AnswerView · RunHistory
├── scripts/run.ts            `npm run workflow -- "<query>"` prints a trace against the live directory
└── tests/                    vitest, fully mocked (fake backend + fake LLM/embedding)
```

Local port **3008** (3001 widget · 3003 orchestrator · 3005 convex · 3006 supabase · 3007 v2).
`.gitignore` as in V2. Not deployed; the API route has no auth and the README says so.

## 4. The pipeline

`runWorkflow(input: WorkflowInput, overrides?: Partial<WorkflowConfig>, deps?) → Promise<WorkflowTrace>`

```ts
interface WorkflowInput {
  query: string;                 // original_user_query — never altered
  homeCity?: string;             // explicit home city (dev UI field)
  sessionCities?: string[];      // cities resolved earlier in the session, most recent first
}
```

`deps` (backend, embed, LLM) are injectable so tests never touch the network; defaults are the
real Supabase facade, `embedText` and Azure gpt-4.1 via `getAzureChatModel()`.

Every stage returns `{ output, meta }`; the runner wraps it into a `StageRecord`:

```ts
interface StageRecord<I, O> {
  id: "detect-city" | "reformulate" | "nearby-cities" | "search" | "rerank" | "respond";
  title: string;
  status: "ok" | "warning" | "error" | "skipped";
  durationMs: number;
  input: I;                      // what the stage received
  output?: O;                    // what it produced
  config: Record<string, unknown>;   // the dials this stage used
  filters?: Record<string, unknown>; // e.g. city filter, tags, threshold
  counts?: Record<string, number>;   // e.g. candidates in / out
  warnings: string[];
  error?: { message: string };
}
interface WorkflowTrace {
  runId: string; startedAt: string; totalMs: number;
  status: "ok" | "needs_clarification" | "failed";
  input: WorkflowInput; config: WorkflowConfig;
  stages: StageRecord[];          // in order; later stages "skipped" when the run stops
  answer?: string;                // stage 6 prose
  recommendations?: Recommendation[]; // structured top K (name, city, distanceKm, scores, profile)
  clarification?: string;         // when status = needs_clarification
}
```

### Stage 1 — Detect city (`1-detect-city.ts`)
- One `generateObject` call: `{ cityMention: string | null }` — the location verbatim as
  mentioned (may be misspelled), null if none. Nothing else is extracted here.
- Resolution order: `config.targetCity` override → `cityMention` → `input.homeCity` →
  `input.sessionCities[0]`. Each candidate goes through `backend.resolveCityFuzzy`; a hit with
  confidence ≥ `cityConfidenceMin` wins. Output records `{ mention, canonical, centroid,
  confidence, source: "override" | "explicit" | "home" | "session" }` and the candidates tried.
- No resolvable city ⇒ stage `status: "warning"`, run `status: "needs_clarification"`,
  `clarification` = a short German question ("In welcher Stadt suchst du?"), stages 2–6 skipped.

### Stage 2 — Reformulate (`2-reformulate.ts`)
- If `enableQueryReformulation`: one `generateText` call with a fixed instruction: rewrite the
  question into a descriptive German semantic-search query; keep the user's intent, the service
  or sport, health need, preferences and constraints; do not add facts; do not answer; one
  paragraph, ≤ `maxRetrievalQueryChars`. The city name is kept in the text (harmless for the
  embedding, helps tags/full-text).
- Output `{ originalUserQuery, retrievalQuery, reformulated: boolean, model }`. Off ⇒ identity
  with `reformulated: false`. An LLM failure ⇒ `warning`, fall back to the original query (the
  run continues).

### Stage 3 — Nearby cities (`3-nearby-cities.ts`)
- `findNearbyCities` (reused, centroids + Haversine) with `limit = maxNearbyCities`,
  `hubs = maxNearbyHubs`, `maxDistanceKm = searchRadiusKm`.
- Output: the ordered city list `[{ city, distanceKm, partnerCount, role: "target" | "nearby" }]`,
  target first at 0 km when `includeTargetCity` (default true), then nearby by distance.
  Counts: cities within radius, cities chosen.

### Stage 4 — Search (`4-search.ts`)
- **One** `embedText(retrievalQuery)`; output records `{ model, dimensions, preview: first 8
  values }` and the embedding stays in the trace only as that preview (the full vector is not
  shipped to the UI).
- For each city from stage 3 (limiter `maxParallelSearches`): `backend.matchPartners({
  queryEmbedding, queryText: retrievalQuery, filters: { city }, matchCount: topKSimilarity })`.
  Per-city failure ⇒ warning, city marked `failed`, run continues. Rows with
  `similarity < similarityThreshold` are dropped and counted.
- Output: `perCity: [{ city, role, distanceKm, requested: topKSimilarity, returned, kept,
  results: [{ id, name, city, tags, similarity, rankInCity }] }]` plus total candidates.

### Stage 5 — Rerank (`5-rerank.ts`)
- Combine all per-city results; dedupe by partner id (target-city occurrence wins, then nearer).
- Relevance: `scoreRelevance` (cosine of the query embedding vs the stored partner embedding
  from `backend.getPartnerEmbeddings`, one batched call); fallback = the RPC similarity when an
  embedding is missing (flagged per row).
- `locationTerm = +targetCityBonus` for the target city, `−maxDistancePenalty × distanceKm /
  searchRadiusKm` for nearby (clamped). Nearby rows with `relevance < minNearbyRelevance` are
  dropped ("proximity alone earns nothing"); target-city rows are never floor-checked.
- `finalScore = relevance + locationTerm`; order by finalScore, then target-first, nearer, in-city
  rank, id. Keep `topKReranked`.
- Output: the **full** ranked table `[{ rank, id, name, city, role, distanceKm, similarity,
  relevance, relevanceSource, locationTerm, finalScore, kept: boolean, dropReason? }]` so the UI
  can show the cut. Counts: combined, duplicates removed, floor-dropped, kept.
- Implemented as a `Reranker` interface `{ name, rerank(candidates, ctx) }` with the
  `embeddingReranker` as the only implementation; `config.reranker = "embedding"`.

### Stage 6 — Respond (`6-respond.ts`)
- `backend.getPartnerProfiles(ids of kept rows)`; a partner whose profile is missing is dropped
  with a warning (the next-ranked kept row is **not** promoted — the cut is fixed at stage 5 so
  the UI and the answer agree).
- One `generateText` call. Prompt: German, concise; opening line naming the target city and that
  nearby cities were included when any kept row is nearby; a numbered list "**N. Name — City[,
  ca. X km]**" followed by one or two sentences on *why* it fits the user's request, using only
  the profile text; contact details from the profile where present; never invent a partner,
  price, opening hour or service; do not mention scores, embeddings or the search mechanics.
- Output: `{ answer, recommendations }` where `recommendations[]` is the structured list
  (rank, id, name, city, distanceKm, finalScore, relevance, profile summary) — the UI shows both.

### Runner semantics
- Stages run strictly in order; a thrown error in a stage is recorded (`status: "error"`, message,
  no stack in the UI) and the run stops with `status: "failed"`, remaining stages `skipped`.
- Whole-run deadline `runTimeoutMs` via `AbortSignal`; per-call `callTimeoutMs` for directory /
  embedding calls and `modelTimeoutMs` for the three chat-model calls. Timeouts surface as that
  stage's error.
- The runner never throws; the API route always returns a trace (HTTP 200) unless the body is
  invalid (400).

## 5. Configuration — `config/workflow.config.ts`

| Dial | Env | Default | Used by |
|---|---|---|---|
| `homeCity` | — (input) | — | 1 |
| `targetCity` | — (override) | — | 1 (forces the city) |
| `cityConfidenceMin` | `V3_CITY_CONFIDENCE_MIN` | 0.6 | 1 |
| `enableQueryReformulation` | `V3_ENABLE_REFORMULATION` | true | 2 |
| `maxRetrievalQueryChars` | `V3_MAX_RETRIEVAL_QUERY_CHARS` | 400 | 2 |
| `searchRadiusKm` | `V3_SEARCH_RADIUS_KM` | 30 | 3, 5 |
| `maxNearbyCities` | `V3_MAX_NEARBY_CITIES` | 5 | 3 |
| `maxNearbyHubs` | `V3_MAX_NEARBY_HUBS` | 2 | 3 |
| `includeTargetCity` | `V3_INCLUDE_TARGET_CITY` | true | 3, 4 |
| `topKSimilarity` | `V3_TOP_K_SIMILARITY` | 15 (per city; ≤ 40, RPC cap) | 4 |
| `similarityThreshold` | `V3_SIMILARITY_THRESHOLD` | 0.2 | 4 |
| `maxParallelSearches` | `V3_MAX_PARALLEL_SEARCHES` | 4 | 4 |
| `topKReranked` | `V3_TOP_K_RERANKED` | 5 | 5 |
| `targetCityBonus` | `V3_TARGET_CITY_BONUS` | 0.05 | 5 |
| `maxDistancePenalty` | `V3_MAX_DISTANCE_PENALTY` | 0.05 | 5 |
| `minNearbyRelevance` | `V3_MIN_NEARBY_RELEVANCE` | 0.15 | 5 |
| `reranker` | `V3_RERANKER` | `"embedding"` | 5 |
| `runTimeoutMs` / `callTimeoutMs` | `V3_RUN_TIMEOUT_MS` / `V3_CALL_TIMEOUT_MS` | 45000 / 8000 | all (`callTimeoutMs`: directory + embedding calls only) |
| `modelTimeoutMs` | `V3_MODEL_TIMEOUT_MS` | 20000 | 1, 2, 6 (the three chat-model calls) |

Precedence: per-request override (API body / UI) > env > defaults. `loadConfig()` validates
ranges (e.g. `topKSimilarity ≤ 40`, `0 ≤ thresholds ≤ 1`) and returns the effective config, which
the trace echoes back.

## 6. API — `app/api/workflow/route.ts`

- `POST /api/workflow` body `{ query, homeCity?, sessionCities?, config?: Partial<WorkflowConfig> }`
  (zod-validated) → `WorkflowTrace` JSON. `runtime = "nodejs"`, `maxDuration = 60`.
- `GET /api/workflow` → `{ defaults: WorkflowConfig, env: which dials are env-set }` for the form.

## 7. Developer UI — `app/page.tsx`

One page, three areas:

1. **Query bar** — textarea, `homeCity` field, example-query chips (the owner's four examples +
   the Dortmund Knieverletzung one), **Run** button, elapsed time, run status pill.
2. **Config panel** (collapsible) — one input per dial in §5 with its default as placeholder,
   "Reset to defaults", and an "env-set" marker. Changes apply to the next run only.
3. **Stage list** — six collapsible sections in order (`▼ Detect City · Reformulate · Nearby
   Cities · Similarity Search · Rerank · Final Response`), each with status pill, duration, and
   **Input / Output / Config used / Filters / Counts / Warnings / Error** blocks (JSON viewer for
   raw values). Stage-specific views:
   - Detect City: candidates tried (source, mention, resolved, confidence) and the winner.
   - Reformulate: original vs retrieval query side by side, "Reformulated: Yes/No".
   - Nearby Cities: table city · role · distance · partner count.
   - Similarity Search: embedding model/dims/preview; one table per city (rank, name, similarity,
     kept/dropped); totals.
   - Rerank: one table (rank · name · city · distance · similarity · relevance · location term ·
     final score), kept rows highlighted, cut rows dimmed with the drop reason; sortable by column.
   - Final Response: rendered markdown answer + the structured recommendations + the profiles the
     model was given.
   Plus **Copy trace JSON** and a **run history** (last 10 runs in memory, click to reopen, so two
   configs can be compared without re-running).

Plain Tailwind, system font, light/dark via `prefers-color-scheme`. It is an internal tool; the
Navio widget palette does not apply.

## 8. Testing

- `tests/_fakes.ts` — port V2's fake backend (`ruhrWorld`) plus a fake LLM (`{ cityMention }`,
  reformulation text, answer text) and fake embedding.
- Stage tests: 1 explicit city · home fallback · session fallback · override · no city ⇒
  clarification · low confidence ⇒ next candidate; 2 on/off/LLM-failure fallback; 3 radius,
  limit, hubs, includeTargetCity=false; 4 one embed call regardless of city count, per-city
  failure = warning, threshold drop, k respected; 5 dedupe (target wins), target beats equal
  nearby, clearly better nearby beats weak target (the owner's Partner C > Partner B case), floor
  drop, topK cut, deterministic tiebreak; 6 missing profile dropped, prompt contains only kept
  partners.
- Runner tests: happy path produces 6 ok stages; failure in stage 4 ⇒ stages 5–6 skipped and
  `status: "failed"`; trace echoes effective config; timeout surfaces as stage error.
- Config tests: env parsing, override precedence, range validation.
- API route test: 400 on bad body, 200 trace on good body (runner mocked).
- `npm run typecheck && npm test` green; `npm run workflow -- "Yoga in Bochum"` against the live
  directory and one run through the UI (`npm run dev -- -p 3008`) as the manual check.

## 9. Out of scope (deliberately)

eve agent wrapper and `/eve/v1` surface · widget integration · Langfuse/LangSmith · feedback ·
LLM reranker (interface only) · multi-request messages ("Tennis in Dortmund und Boxen in Bochum")
· authentication on the API route · deployment.
