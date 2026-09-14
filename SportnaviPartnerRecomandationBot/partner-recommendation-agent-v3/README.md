# Partner Retrieval V3 — Workflow Lab

A **research lab** for a new retrieval strategy for Navio's partner search. It is a standalone
Next.js project, not an eve agent, not wired into the widget, and **not deployed**. It exists to
try out a sequential six-stage pipeline and inspect every intermediate value in a dev UI, before
(or instead of) porting anything into a live agent.

It does not replace, modify or import from the existing agents
(`../partner-recommendation-agent-supabase`, `../partner-recommendation-agent-convex`,
`../partner-recommendation-agent-v2`). All can run side by side.

## The pipeline

```
Detect city → Reformulate query → Find nearby cities → Embed reformulated query once
  → Similarity search across target + nearby cities → Rerank → Final recommendations
```

Six stages, always in that order (`workflow/run-workflow.ts`):

1. **Detect city** — resolve the target city from the query (or `homeCity` / a dev-UI override).
   No confident city ⇒ the whole run stops with `needs_clarification`.
2. **Reformulate query** — rewrite the question into a descriptive retrieval query (can be
   disabled via config).
3. **Find nearby cities** — pick nearby cities to widen the search.
4. **Embed once + similarity search** — the reformulated query is embedded **exactly once**, then
   searched in parallel across the target city and every nearby city.
5. **Rerank** — combine every city's candidates, dedupe by partner id, put them all on one
   relevance scale, apply a location term, sort, cut to the top N.
6. **Respond** — the model phrases the final answer from the kept rows only.

## Running it

```powershell
npm install
copy .env.local.example .env.local   # then fill in the same Azure / Supabase (service-role) / embedding credentials the live partner agent uses
npm run dev -- -p 3008        # → http://localhost:3008
```

CLI, instead of the UI:

```powershell
npm run workflow -- "Yoga in Bochum"
npm run workflow -- "Yoga in Bochum" --home Dortmund --radius 40
npm run workflow -- "Yoga in Bochum" --json     # also dumps the full WorkflowTrace
```

`--home <city>` sets `homeCity`; multi-word cities need quoting (`--home "Bad Homburg"`).
`--radius <km>` overrides `searchRadiusKm` for that run only. Both are optional; the query is
every remaining argument joined with spaces.

Checks:

```powershell
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Configuration

Every dial lives in `config/workflow.config.ts` (`DEFAULT_CONFIG`). Precedence is
**per-request override (dev-UI config panel or the CLI `--radius` flag) > `V3_*` env var >
default**. Nothing else in this folder hard-codes these numbers.

| Dial | Env var | Default | Used by |
|---|---|---|---|
| `targetCity` | — (override only) | unset | Stage 1 — forces the target city instead of detecting it |
| `cityConfidenceMin` | `V3_CITY_CONFIDENCE_MIN` | `0.6` | Stage 1 — below this fuzzy-match confidence, the city is treated as unknown |
| `enableQueryReformulation` | `V3_ENABLE_REFORMULATION` | `true` | Stage 2 — turn the rewrite on/off |
| `maxRetrievalQueryChars` | `V3_MAX_RETRIEVAL_QUERY_CHARS` | `400` | Stage 2 — hard cap on the retrieval query length |
| `searchRadiusKm` | `V3_SEARCH_RADIUS_KM` | `30` | Stage 3 ("nearby") and Stage 5 (distance at which the penalty maxes out) |
| `maxNearbyCities` | `V3_MAX_NEARBY_CITIES` | `5` | Stage 3 — how many nearest cities to search |
| `maxNearbyHubs` | `V3_MAX_NEARBY_HUBS` | `2` | Stage 3 — extra best-supplied cities inside the radius |
| `includeTargetCity` | `V3_INCLUDE_TARGET_CITY` | `true` | Stage 3/4 — whether the target city itself is searched |
| `topKSimilarity` | `V3_TOP_K_SIMILARITY` | `15` | Stage 4 — candidates per city (`match_partners` vector branch caps at 40) |
| `similarityThreshold` | `V3_SIMILARITY_THRESHOLD` | `0.2` | Stage 4 — drop rows below this directory similarity |
| `maxParallelSearches` | `V3_MAX_PARALLEL_SEARCHES` | `4` | Stage 4 — concurrent per-city searches |
| `topKReranked` | `V3_TOP_K_RERANKED` | `5` | Stage 5 — how many partners survive the rerank (what the user sees) |
| `targetCityBonus` | `V3_TARGET_CITY_BONUS` | `0.05` | Stage 5 — added to a target-city partner's relevance |
| `maxDistancePenalty` | `V3_MAX_DISTANCE_PENALTY` | `0.05` | Stage 5 — penalty at `searchRadiusKm`, scaled linearly from 0 at the target city |
| `minNearbyRelevance` | `V3_MIN_NEARBY_RELEVANCE` | `0.15` | Stage 5 — nearby partners below this relevance are dropped; target-city ones never are |
| `reranker` | `V3_RERANKER` | `"embedding"` | Stage 5 — which reranker implementation |
| `runTimeoutMs` | `V3_RUN_TIMEOUT_MS` | `45000` | whole-run deadline |
| `callTimeoutMs` | `V3_CALL_TIMEOUT_MS` | `8000` | one directory / embedding round trip (never a model call) |
| `modelTimeoutMs` | `V3_MODEL_TIMEOUT_MS` | `20000` | one chat-model call: Stage 1 city detection, Stage 2 reformulation, Stage 6 answer |

`GET /api/workflow` returns the resolved defaults plus which keys came from env (`envSet`), and
the dev UI's config panel reads that to show overrides against the actual baseline.

## How the rerank works

Stage 5 puts every surviving candidate on one scale:

```
finalScore = relevance + locationTerm
```

`relevance` is the cosine similarity between the (single, reused) query embedding and the
partner's stored embedding — falling back to the directory's own similarity score if a partner
has no stored embedding or a dimension mismatch (see below). `locationTerm` is:

- **target city:** flat `+targetCityBonus`
- **nearby city:** `-maxDistancePenalty * min(1, distanceKm / searchRadiusKm)` — 0 at the target
  city, ramping linearly to the full penalty at `searchRadiusKm`

Ties on `finalScore` favor target-city role, then shorter distance, then in-city rank, then id — so an
equally-relevant nearby partner never beats a target-city one, but a **clearly** more relevant
nearby partner can.

**Worked example** (`searchRadiusKm: 30`, `targetCityBonus: 0.05`, `maxDistancePenalty: 0.05`):

| Partner | relevance | role / distance | locationTerm | finalScore |
|---|---|---|---|---|
| A | 0.78 | target (Dortmund) | +0.05 | **0.83** |
| C | 0.86 | nearby, Bochum, 18 km | −0.05 × 18/30 = −0.03 | **0.83** |
| D | 0.81 | nearby, Lünen, 15 km | −0.05 × 15/30 = −0.025 | **0.785** |
| B | 0.65 | target (Dortmund) | +0.05 | **0.70** |
| E | 0.72 | nearby, Hagen, 20 km | −0.05 × 20/30 ≈ −0.0333 | **0.687** |

Final order: **A (0.83, target) → C (0.83, nearby) → D (0.785) → B (0.70) → E (0.687)** — A and C
tie exactly on score, and the target-city tiebreak puts A first.

`minNearbyRelevance` (default `0.15`) is a floor applied only to nearby-role rows: a nearby
partner whose `relevance` is below it is dropped before ranking, regardless of `locationTerm`
(target-city rows are never dropped by this floor). Dropped rows still appear in the trace with
`kept: false` and a `dropReason`, whether they were cut by the floor or simply fell past
`topKReranked`.

## The dev UI

`http://localhost:3008` (or whatever `-p` you pass) shows, top to bottom:

- **Query form** — free-text query, optional home city, Run.
- **Config panel** — every dial from the table above, pre-filled with the resolved defaults and
  marked where an env var is already overriding the default; edits here become per-run overrides
  sent with the next request only.
- **Run history** — the last 10 runs in this browser session, selectable.
- **Pipeline strip** — one chip per stage (status + timing), click to jump to that stage's
  section.
- **Six collapsible stage sections**, one per pipeline stage, each showing: **Input**, **Output**
  (raw), **Config** (the exact dial values that stage used), **Filters** (when the stage applied
  any), **Counts**, **Warnings**, and **Error** (only on failure) — plus a stage-specific view:
  the rerank section additionally renders a sortable table of every candidate with dimmed rows for
  anything not kept and its `dropReason` next to it.
- **Copy trace JSON** — copies the full `WorkflowTrace` for the selected run to the clipboard.

## Error semantics

The runner (`workflow/run-workflow.ts`) **never throws**. Every run ends in one of these
`WorkflowTrace.status` values:

- **`ok`** — all six stages ran; `answer` and `recommendations` are populated.
- **`needs_clarification`** — stage 1 could not resolve a city with enough confidence; the run
  stops there (stages 2–6 recorded as `skipped`) and `trace.clarification` carries the message to
  show the user.
- **`failed`** — a stage threw, or the request's config overrides failed `validateConfig`; the
  failing stage is marked `error` with the exception's message, later stages are `skipped`, and
  `trace.error` mirrors the message at the top level.

Within a stage that *did* run, `status` can also be `warning` (ran fine but returned one or more
non-fatal warnings, e.g. the rerank's embedding-dimension-mismatch case: a stored partner
embedding has a different dimension than the query's, so that partner falls back to the
directory's own similarity score instead of being dropped) — distinct from `error`, which means
the stage itself threw.

## Reuse rule

`lib/reused/` holds files **copied unchanged** from
`../partner-recommendation-agent-v2/lib/reused/` (itself originally copied from the live Supabase
agent), each with a header comment naming its source and copy date. V3 **never imports** across
folder boundaries — copying keeps this lab free of any build-time dependency on the live agents or
V2, and keeps them free of any change from this folder. `lib/abortable.ts` is V3's own code, not a
copy — it complements `lib/reused/timeout.ts`'s fixed-deadline timeout with signal-based
cancellation propagated from the run's own `AbortSignal`.

## Limits

- `/api/workflow` has **no auth** — it's a local dev tool, not a public endpoint. `next dev` binds
  **all interfaces**, so anyone reachable on the network can trigger paid model calls; on a shared
  network run `npm run dev -- -p 3008 -H 127.0.0.1`.
- Each run costs **3 chat completions + 1 embedding** and there is **no rate limit**.
- Node **>= 20.3** is required (`AbortSignal.any`).
- Not deployed anywhere; no Vercel project, no `vercel.json`.
- No Langfuse, no feedback loop, no evals — the trace JSON is the only observability.
- Only one reranker is implemented (`embedding`); the `reranker` dial exists for future
  alternatives but `"embedding"` is the only valid value today.
- One workflow run per chat message — there is no multi-turn session state or follow-up handling.
- Uses `ai@7`'s `generateObject`, which is deprecated in that version; fine for a lab, worth
  revisiting before anything here is promoted.

## Port map

| Service | Port |
|---|---|
| Navio widget | 3001 |
| Orchestrator | 3003 |
| Partner agent (Convex, live) | 3005 |
| Partner agent (Supabase) | 3006 |
| Partner agent V2 | 3007 |
| **Partner retrieval V3 (this folder)** | **3008** |
