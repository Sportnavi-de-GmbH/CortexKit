# Partner Retrieval V3 — Workflow Lab

A **research lab** for a new retrieval strategy for Navio's partner search. It is a standalone
Next.js project, not an eve agent, not wired into the widget, and **not deployed**. It exists to
try out a seven-stage pipeline — an up-front decompose stage plus stages 1–6 run per task, up to 3
in parallel — and inspect every intermediate value in a dev UI, before (or instead of) porting
anything into a live agent.

It does not replace, modify or import from the existing agents
(`../partner-recommendation-agent-supabase`, `../partner-recommendation-agent-convex`,
`../partner-recommendation-agent-v2`). All can run side by side.

## The pipeline

```
Decompose message → [per task, ≤ 3 in parallel] Detect city → Reformulate query
  → Find nearby cities → Embed reformulated query once → Similarity search across
  target + nearby cities → Rerank → Final recommendations
```

Seven stages (`workflow/run-workflow.ts`):

0. **Decompose** — one model call splits the message into independent tasks (different activity
   OR place); ids are assigned by code; deferred tasks from the previous turn go first; the top
   `maxTasksPerTurn` (≤ 3) run, the rest are deferred. Model failure ⇒ the whole message is one
   task.
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

Stages 1–6 run **per task**, at most 3 tasks concurrently via `runWithLimit`. Stage 1 uses stage
0's `cityMention` hint for that task instead of making its own model call — except when
decomposition is disabled/degraded or the task carried over from a previous turn, where stage 1
falls back to its own city-detection model call.

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
| `enableDecomposition` | `V3_ENABLE_DECOMPOSITION` | `true` | Stage 0 — off ⇒ the whole message is one task |
| `maxTasksPerTurn` | `V3_MAX_TASKS_PER_TURN` | `3` | Stage 0 — tasks run per turn AND pool concurrency; validated `1..3`, never more |

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

## Multiple searches in one message

Stage 0 can split one message into up to `maxTasksPerTurn` (default 3) independent tasks — e.g.
*"Yoga in Bochum und Klettern in Essen"* becomes two tasks, each run through stages 1–6 on its
own, in parallel. The composed answer is one bold section per task:

```
**Yoga in Bochum**
… answer for that task …

**Klettern in Essen**
… answer for that task …
```

If a message names more tasks than fit, the extra ones are **deferred**: the answer still covers
the tasks that ran, followed by a closing note naming the deferred labels, e.g. `(Notiert für
danach: Reha-Sport in Dortmund – sag einfach Bescheid, dann suche ich weiter.)`.

If one or more tasks can't resolve a city, clarification is asked **once per turn** for all of
them together — a label list in the compose module's own quoting style, e.g. `für „Yoga in
Bochum“ und „Klettern“: in welcher Stadt …` — while the other tasks' answers are still delivered
in the same `answer` text, and those unresolved tasks are carried in `trace.pending`. Overall
`status` precedence is: `failed` only when *every* task failed; `partial` when some (not all)
failed; otherwise `needs_clarification` if any task needs it; otherwise `ok`. A task whose stage
threw instead gets its own `**Label**` failure line and does not block the others.

**Resume contract.** The client is the only place multi-turn state lives: after a run, if
`trace.pending` or `trace.deferred` is non-empty, the client holds onto both and sends them back
as `resume: { pending, deferred }` on the next request. Stage 0 then runs deferred tasks first
(they already waited a turn), and reuses a pending task's id (inside the turn's single stage-0
model call) only when the model's fresh output names `resolvesPending` with that id, i.e. it
recognised the new message as answering that earlier clarification. A pending task that is not
recognised in a later message is silently dropped, with a warning on the decompose stage
(`Pending task(s) not answered by this message were dropped: …`).

**Cost.** For N tasks in one turn: 1 decompose call, plus per task 1 reformulate + 1 answer call
(and 1 detect-city call only when stage 1 has no hint from stage 0 — a task that is disabled,
degraded, or carried over from a previous turn), plus 1 embedding per task. Normally (stage 1 uses
the hint): **1 + 2·N chat completions + N embeddings**. When detection falls back to its own model
call for every task: **1 + 3·N chat completions + N embeddings**.

## The dev UI

`http://localhost:3008` (or whatever `-p` you pass) shows, top to bottom:

- **Query form** — free-text query, optional home city, Run.
- **Resume chip** — when the previous run left `pending` and/or `deferred` tasks, the query form
  shows a "Weiter mit:" chip listing both counts and labels, with a `×` button to discard the
  resume state instead of sending it on the next run.
- **Config panel** — every dial from the table above, pre-filled with the resolved defaults and
  marked where an env var is already overriding the default; edits here become per-run overrides
  sent with the next request only.
- **Run history** — the last 10 runs in this browser session, selectable.
- **Composed answer card** — the final `trace.answer` (or `trace.clarification`) rendered as
  markdown, above the stage sections.
- **Decompose section** — the stage-0 trace (tasks produced, which are runnable vs. deferred,
  degraded flag, warnings), shown before the per-task stages.
- **Task strip** — one chip per executed task (label, status, ms); only rendered when a message
  produced more than one task. Selecting a chip switches the pipeline strip and stage sections
  below to that task's run.
- **Pipeline strip** — one chip per stage (status + timing) for the selected task, click to jump
  to that stage's section.
- **Six collapsible stage sections** for the selected task, one per stage 1–6, each showing:
  **Input**, **Output** (raw), **Config** (the exact dial values that stage used), **Filters**
  (when the stage applied any), **Counts**, **Warnings**, and **Error** (only on failure) — plus a
  stage-specific view: the rerank section additionally renders a sortable table of every candidate
  with dimmed rows for anything not kept and its `dropReason` next to it.
- **Copy trace JSON** — copies the full `WorkflowTrace` for the selected run to the clipboard.

## Error semantics

The runner (`workflow/run-workflow.ts`) **never throws**. Every run ends in one of these
`WorkflowTrace.status` values:

- **`ok`** — every task ran stages 1–6 to completion; `answer` and (for a single task)
  `recommendations` are populated.
- **`needs_clarification`** — at least one task could not resolve a city with enough confidence;
  the others' answers are still in `answer`, and `trace.pending` holds the unresolved task(s) and
  `trace.clarification` the question asked.
- **`partial`** — at least one task failed but not all of them; the successful tasks' answers are
  still in `answer`, and `trace.error` summarizes the failed task(s).
- **`failed`** — every task failed, or the request's config overrides failed `validateConfig`, or
  the decompose stage itself threw; the failing stage(s) are marked `error` with the exception's
  message, later stages are `skipped`, and `trace.error` mirrors the message at the top level.

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
- For N tasks, a run normally costs **1 + 2·N chat completions + N embeddings** (1 + 3·N chat
  completions when stage 1 falls back to its own city-detection call instead of using stage 0's
  hint) and there is **no rate limit**.
- Node **>= 20.3** is required (`AbortSignal.any`).
- Not deployed anywhere; no Vercel project, no `vercel.json`.
- No Langfuse, no feedback loop, no evals — the trace JSON is the only observability.
- Only one reranker is implemented (`embedding`); the `reranker` dial exists for future
  alternatives but `"embedding"` is the only valid value today.
- Multi-turn state is client-held (`resume`); the server stores nothing between requests.
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
