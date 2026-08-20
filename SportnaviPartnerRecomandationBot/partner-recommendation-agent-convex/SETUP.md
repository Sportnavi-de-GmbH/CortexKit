# SETUP — from a clean machine to a running Convex agent

Every step is a command. Nothing about the database is left as a manual or
undocumented step: the schema is code, the data load is a script, and there is
a verification command that proves the deployment is complete rather than
half-seeded.

Total time: ~15 minutes, most of it the data seed.

---

## 0. What you need before you start

| Thing | Why | Where it comes from |
|---|---|---|
| Node.js 20+ | runtime | already installed if the Supabase build runs |
| A Convex account | hosts the deployment | free at [convex.dev](https://convex.dev) — `npx convex dev` walks you through it |
| Azure OpenAI chat deployment | the model that writes answers | **you provide** — use the SAME one as the Supabase build |
| An embeddings endpoint serving `text-embedding-3-small` | 1536-dim, must match the stored vectors | **you provide** — use the SAME one as the Supabase build |
| Supabase service-role key | the ONE-TIME data export | **you provide** — the same key the Supabase build uses |

The full list of environment variables, with what each one is for, is in
[`.env.local.example`](.env.local.example). **Nothing in it is filled in for
you.** Section 7 of this document lists exactly what you must supply.

---

## 1. Install

```bash
cd partner-recommendation-agent-convex
npm install
```

Everything below runs from this directory.

> ### ⚠ Do not delete `package-lock.json`
>
> It is a **copy of the Supabase build's lockfile**, and it is load-bearing
> twice over.
>
> **It keeps the app working.** `eve` is declared as `"eve": "0.25.2"` — an
> exact pin, not a caret — because **eve 0.25.3 does not boot this project**:
> its `env-runner` loads type-stripped virtual modules through
> `module.registerHooks`, and Node then fails to classify one of them:
>
> ```
> [env-runner] worker init failed: Cannot determine intended module format
> because both '__filename' and top-level await are present.
> ```
>
> **It keeps the benchmark honest.** Every other shared dependency resolves to
> the same version as the Supabase build. Deleting the lock floats `next`,
> `ai` and `@ai-sdk/openai` to newer releases, and you are then comparing two
> different agent runtimes rather than two backends.
>
> If you must regenerate it, copy it from the Supabase build again:
>
> ```bash
> cp ../partner-recommendation-agent/package-lock.json . && npm install
> npm run check:env      # and confirm credentials still match
> ```

---

## 2. Create the Convex deployment

```bash
npx convex dev
```

This is interactive the first time. It will:

1. open a browser to log you in (or create an account),
2. create a deployment for this project,
3. **write `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` into `.env.local`
   for you** — you do not type these by hand,
4. push `convex/schema.ts` and every function in `convex/`,
5. generate `convex/_generated/` (typed API + data model),
6. stay running and hot-reload on change.

The push creates all ten tables, their indexes, and the 1536-dimension vector
index. **There is no separate "run the migrations" step for structure** —
Convex derives it from `schema.ts` on every push. That is the whole
`supabase db push` equivalent.

Leave this running in its own terminal, or press Ctrl-C once it prints
`Convex functions ready!` and use `npx convex dev --once` for one-shot pushes
later.

> **Offline / no account?** `CONVEX_AGENT_MODE=anonymous npx convex dev` runs a
> local backend on `127.0.0.1:3210` with no login. Good for trying the schema
> out; not what you want for a latency benchmark, since it measures your laptop
> rather than the hosted service.

---

## 3. Fill in the rest of `.env.local`

`npx convex dev` created `.env.local` with the two Convex variables. If the
Supabase build is already configured, copy its credentials across
automatically:

```bash
npm run sync:env
```

That reads `../partner-recommendation-agent/.env.local` and copies every
**shared** credential, printing a short hash per variable so you can see what
changed without a secret appearing on screen. It deliberately does **not**
copy `LANGSMITH_PROJECT` (the two builds need different trace projects) and
never touches the `CONVEX_*` variables.

Otherwise, fill them in by hand from
[`.env.local.example`](.env.local.example). At minimum you must set:

- `AZURE_AI_CHATBOT_OPENAI_ENDPOINT`, `AZURE_AI_CHATBOT_API_KEY`,
  `AZURE_AI_CHATBOT_DEPLOYMENT_NAME`
- `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`
- `MEMORY_SUPABASE_URL`, `MEMORY_SUPABASE_SERVICE_ROLE_KEY` (step 4 only)

> **Re-run `npm run sync:env` every time you change a credential in the
> Supabase build** — a new Azure deployment, a rotated key. The two files drift
> silently otherwise, and the symptom is confusing: one build starts failing on
> a rate-limited or decommissioned deployment while the other is fine, and any
> benchmark between them is measuring two different models.
> `npm run check:env` reports drift without writing (exit 1 if any), so it fits
> in a pre-benchmark check.

---

## 4. Export the data out of Supabase (one time)

```bash
npm run convex:export
```

Reads the live directory and writes `data/export/`:

```
partners.jsonl      2,333 rows — every column plus the precomputed German FTS lexemes
embeddings.jsonl    2,333 rows — the 1536-dim profile_embedding vectors
intelligence.jsonl  2,333 rows — partner_intelligence (quality_score + sub-scores)
tags.json           tag_synonyms (89) + okf.tag_variants (706)
manifest.json       row counts + timestamp
```

The script **refuses to write a manifest for a truncated export**: it
cross-checks its paged reads against an authoritative `count(*)` and against
the number of vectors it found. That guard exists because PostgREST silently
caps unbounded responses at 1,000 rows, and that exact failure hid 314 cities
from the Supabase build for weeks (root `CLAUDE.md` §10.9).

`data/export/` is gitignored (~50 MB of real partner data). It is a portable
artifact: **anyone with this directory can seed a Convex deployment without any
Supabase credentials at all.** That is what makes repeated benchmark runs
reproducible — everyone loads bit-identical data.

**The service-role key is mandatory.** `partners` has RLS enabled with no
policies, so the anon key returns zero rows *silently* — you would get a
successful export of nothing.

---

## 5. Seed Convex

```bash
npm run convex:seed
```

Streams `data/export/` into the deployment and then materializes the
aggregates. Roughly 3–8 minutes, dominated by the 2,333 embedding vectors.

What it does, in order:

1. `migrations:upsertPartnersBatch` — the `partners` rows, and the derived
   `partnerSearchDocs` ranking projection
2. `migrations:upsertEmbeddingsBatch` — the vector index
3. `migrations:upsertIntelligenceBatch` — `partner_intelligence`
4. `migrations:upsertTagsBatch` — tag synonyms and variants
5. `migrations:rebuildCityAggregates` — **the step you must not skip.** Convex
   has no SQL `GROUP BY`, so the two aggregates `resolve_city_fuzzy` and
   `city_centroids()` used to compute on the fly are materialized into the
   `citySpellings` / `cityCentroids` / `cityCoverage` tables here. A seeded
   deployment without them resolves **no cities at all**.
6. `migrations:recordMigration` — the bookkeeping row `convex:verify` reads

Every write is an **upsert keyed on the natural key**, so re-running converges
instead of duplicating.

```bash
npm run convex:reseed   # same, but wipes the deployment first
```

Use `reseed` when rows were *removed* upstream — an upsert cannot delete what
is no longer in the export.

---

## 6. Verify

```bash
npm run convex:verify
```

This is the step that turns "it ran without errors" into "it is actually
correct". It runs six groups of live assertions:

| Check | What it catches |
|---|---|
| **S1** row counts | a half-seeded deployment — the failure most easily mistaken for "this city is thin" |
| **S2** city map | a truncated centroid table (the 334-of-648 bug) |
| **S3** hydration | partners reaching the model with empty profile text — the fabrication setup of root `CLAUDE.md` §11 |
| **S4** tag branch | `filters.tags` not reaching the search, killing one of four RRF branches |
| **S5** vector branch | an unpopulated or unqueried vector index |
| **S6** German FTS | the ported Snowball stemmer drifting from Postgres' `german` dictionary |

Expected output ends with:

```
All checks passed — the Convex deployment is ready to benchmark.
```

If anything fails, see [Troubleshooting](#troubleshooting) below.

> `npm run setup` runs steps 4–6 in one go.

---

## 7. Environment variables — what YOU must provide

**Written for you by `npx convex dev` — do not type these:**

| Variable | Value |
|---|---|
| `CONVEX_DEPLOYMENT` | e.g. `dev:some-animal-123` |
| `NEXT_PUBLIC_CONVEX_URL` | e.g. `https://some-animal-123.convex.cloud` |

**You must provide these.** Use the *same values as the Supabase build* for
every one of them, or the benchmark compares two different systems:

| Variable | What to put there |
|---|---|
| `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` | your Azure OpenAI resource endpoint URL |
| `AZURE_AI_CHATBOT_API_KEY` | your Azure OpenAI API key |
| `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` | your chat deployment name (e.g. `gpt-4.1`) |
| `EMBEDDING_API_URL` | endpoint serving `text-embedding-3-small` at 1536 dims |
| `EMBEDDING_API_KEY` | its API key |
| `MEMORY_SUPABASE_URL` | Supabase project URL — **step 4 only** |
| `MEMORY_SUPABASE_SERVICE_ROLE_KEY` | Supabase **service-role** key — **step 4 only** |

**Optional, all silent no-ops when unset:**

| Variable | Note |
|---|---|
| `SENTRY_*` | error capture; a missing DSN disables it entirely |
| `LANGSMITH_*` | tracing. Set `LANGSMITH_PROJECT` to something **different** from the Supabase build's, or the two builds' traces mix |
| `BENCHMARK_SUPABASE_PROJECT_DIR` | path to the Supabase build; defaults to `../partner-recommendation-agent` |

I have not invented a value for any of these. Every blank above is a real
credential you have to supply.

---

## 8. Run the agent

```bash
npm run dev:ui     # Next.js dev console + eve backend  -> http://localhost:3000
npm run dev        # eve backend only, no dashboard
npm run smoke      # live credential + pipeline smoke test
npm test           # 304 unit tests, fully mocked, no secrets needed
npm run typecheck  # tsc --noEmit
```

Keep `npx convex dev` running in another terminal while you develop, so
function changes hot-reload.

---

## 9. Deploy to production (optional)

```bash
npx convex deploy          # pushes schema + functions to the prod deployment
```

Then seed prod the same way, pointing `CONVEX_URL` at the production URL:

```bash
CONVEX_URL=https://<prod>.convex.cloud npm run convex:seed
CONVEX_URL=https://<prod>.convex.cloud npm run convex:verify
```

> **Note on access control.** The Convex functions in this build are PUBLIC:
> anyone with the deployment URL can call them. That mirrors the Supabase
> build's dev-console posture (no auth on the app), but *not* its database
> posture — there, RLS-with-no-policies plus a server-only service-role key
> meant the database itself was closed. Before putting this on the public
> internet, either add Convex auth (`npx convex` + the `convex-auth` skill) or
> gate the five request-path functions behind a shared secret argument. This is
> listed as a known gap in [`MIGRATION-NOTES.md`](MIGRATION-NOTES.md).

---

## 10. After a partner data change

Same two-step discipline as the Supabase build, plus one Convex-specific step:

```bash
npm run convex:export              # 1. re-export from Supabase
npm run convex:reseed              # 2. reload (also rebuilds the aggregates)
npm run generate:coverage          # 3. regenerate the prompt's city list
```

Step 3 matters in both builds: the 40-largest-cities list is baked into the
system prompt, and a stale list makes Navio offer cities that no longer exist.

If you edited partner rows directly in Convex without reseeding, rebuild the
aggregates explicitly — nothing else will:

```bash
npm run convex:rebuild-aggregates
```

---

## Troubleshooting

**`getConvex: missing required environment variable CONVEX_URL`**
`.env.local` has no `CONVEX_URL` or `NEXT_PUBLIC_CONVEX_URL`. Run
`npx convex dev` once; it writes the latter.

**`Cannot find module './_generated/server'`**
Codegen has not run. `npx convex dev --once` (or `npx convex codegen`) creates
`convex/_generated/`. Note that `npm run typecheck` and `npm test` deliberately
do **not** need it — the root `tsconfig.json` excludes `convex/`, and
`lib/convex.ts` uses `makeFunctionReference` instead of the generated API, so
the unit suite runs in an environment with no deployment.

**`cityCoverage is empty` / no city resolves / `Bochum did not resolve`**
`rebuildCityAggregates` did not run, or ran before the partners were loaded.
Run `npm run convex:rebuild-aggregates`.

**S1b fails: search docs ≠ vectors**
Both tables are populated only for partners that are `isActive` **and** have an
embedding, so the counts must match. A mismatch means one of the two batch
loads was interrupted. `npm run convex:reseed`.

**S5 fails: vector branch**
Usually `EMBEDDING_API_URL` / `EMBEDDING_API_KEY`. The endpoint must serve
`text-embedding-3-small` at 1536 dimensions; `lib/embeddings.ts` hard-fails on
any other width rather than silently mixing embedding spaces.

**S6 fails: German stemmer**
`convex/lib/germanFts.ts` was edited and no longer matches Postgres'
`german` dictionary. This one is serious: it means the Convex build's keyword
branch has silently diverged from the Supabase build's, so the benchmark is no
longer apples-to-apples. Revert the change or re-derive the expectations.

**`[env-runner] worker init failed: Cannot determine intended module format`**
You are on eve 0.25.3. It cannot boot this project — see the lockfile warning
in §1. Fix:
```bash
cp ../partner-recommendation-agent/package-lock.json . && npm install
node -p "require('eve/package.json').version"   # must print 0.25.2
```

**`This model's maximum context length is 128000 tokens. However, your
messages resulted in 141416 tokens`**
Not a rate limit — a per-request ceiling, so raising Azure quota changes
nothing. `finalRecommendations: 100` renders ~42k tokens per search and a
multi-intent question triggers several searches in one turn. Both builds now
derive the window from the deployment (`lib/model-limits.ts`) and refuse a
search that would not fit (`lib/request-budget.ts`), so Navio asks which
activity to search first instead of failing. To allow more searches per turn,
lower `finalRecommendations` in
`agent/config/partner-injection.config.ts` — 25 buys ~8 searches, 12 buys ~17.
Change it in BOTH builds. See root `CLAUDE.md` §7.

**The agent answers but every turn fails with a rate limit, or names the wrong
model**
The two builds' `.env.local` have drifted. `npm run check:env`, then
`npm run sync:env`.

**The seed is slow or times out**
Lower `EMBEDDING_BATCH` in `scripts/seed-convex.ts` (default 25). Each row
carries a 1536-float vector, so batches are sized by payload, not row count.

**`export okf.tag_variants` fails with a permissions error**
The `okf` schema may not be exposed through PostgREST on your project. Add it
under Settings → API → Exposed schemas, or export those 706 rows by hand into
`data/export/tags.json`. The agent works without them — you lose only the
variant expansion in the `tg` ranking branch.
