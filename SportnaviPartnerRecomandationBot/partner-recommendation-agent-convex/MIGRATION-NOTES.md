# MIGRATION NOTES — Supabase/Postgres → Convex

What changed, what deliberately did **not**, and every place the two builds are
not identical. Read this before concluding anything from a benchmark number.

The governing constraint: **the backend is the only variable.** Anything else
that differs makes the comparison meaningless, so every difference below is
either forced by the platform or explicitly justified.

---

## 1. What did NOT change

Copied across byte-for-byte. If you diff these against
`../partner-recommendation-agent`, they are the same files:

- **`agent/instructions.md`** — the ~18 KB system prompt, including the
  grounding mandate, rule #6 (contact details) and rule #10 (studio attributes).
- **`agent/config/partner-injection.config.ts`** — the four dials, still on the
  wide-context test profile (`100 / 100 / 10 / 100`, threshold 0.15, 150 km).
- **`agent/agent.ts`**, the two enabled tools, and the nine `disableTool()`
  stubs. Still exactly two tools; still two model steps per search.
- **`lib/partners/resolve-partners.ts`** — the orchestrator. Home city whole →
  concurrent gap-fill → cap, same timeouts, same similarity floor, same
  dedupe, same determinism rules.
- **`lib/partners/build-recommendations.ts`** ranking/disclosure logic,
  **`render-context.ts`**, **`search-cache.ts`**, **`cache.ts`**,
  **`embeddings.ts`**, **`llm.ts`**, **`timeout.ts`**, **`request-budget.ts`**,
  **`grounding-check.ts`**, **`observability.ts`**.
- **`agent/hooks/`**, **`agent/instrumentation.ts`** — Sentry + LangSmith.
- **`app/`**, **`components/`** — the Next.js dev console.
- **`evals/`** — the 10-case edge-case harness and its 14 evaluators.

**Partner ids are preserved.** `partners.sourceId` is the original Postgres
`bigint` id, so both builds return literally the same partner ids for the same
request. That is what makes result-set equality checkable rather than a matter
of opinion.

---

## 2. What changed, and why

### 2.1 The client

| Supabase | Convex |
|---|---|
| `lib/supabase.ts` → `getSupabase(): SupabaseClient` | `lib/convex.ts` → `getConvex(): ConvexBackend` |
| service-role key (RLS on, no policies) | deployment URL |
| chainable PostgREST query builder | five named methods |

`ConvexBackend` is a façade with exactly five methods — one per Postgres
RPC/query the agent used. Anything not on that interface is not on the request
path, which keeps the surface honest. Setup-time calls live in a separate
`lib/convex-admin.ts` so they cannot quietly join the hot path.

### 2.2 The four RPCs

| Postgres | Convex | Notes |
|---|---|---|
| `slugify_tag(t)` | `convex/lib/slugify.ts` | 1:1 port |
| `resolve_city_fuzzy(place)` | `cities:resolveCityFuzzy` | trigram scan over the materialized `citySpellings` table |
| `city_centroids()` | `cities:cityCentroids` | one read of the materialized `cityCentroids` table |
| `get_partner_profiles(ids)` | `partners:getPartnerProfiles` | same 13 columns, same `is_active` predicate |
| `match_partners(...)` | `search:matchPartners` + `searchRanking:fuse` | see §3 |
| *(the `.in("city", …)` query + manual intelligence join)* | `partners:getPartnersByCity` | **two round trips became one** |

### 2.3 Aggregates are materialized

Convex has no SQL `GROUP BY`. Three aggregates that Postgres computed per call
are precomputed into tables by `convex/migrations.ts:rebuildCityAggregates`:

| Table | Postgres equivalent | Grouped by | Coordinate |
|---|---|---|---|
| `citySpellings` | `resolve_city_fuzzy`'s `GROUP BY p.city` | exact spelling | **median** (`percentile_cont(0.5)`, interpolating) |
| `cityCentroids` | `city_centroids()` | `slugify_tag(city)` | **average** |
| `cityCoverage` | `generate-city-coverage`'s `GROUP BY initcap(trim(city))` | trimmed spelling | — (count only) |

They are genuinely different aggregates in Postgres too (median vs average,
exact spelling vs slug), so both exist here. `citySpellings`/`cityCentroids`
require coordinates; `cityCoverage` does not — the prompt's coverage list must
count every partner, geocoded or not.

**Cost:** one rebuild command after any data change (the seed does it
automatically). **Benefit:** no query ever scans 2,331 partners, and there is
no implicit row cap to be silently hit.

### 2.4 One table became three

`public.partners` is split by access pattern:

| Table | Holds | Read by |
|---|---|---|
| `partners` | the row data, incl. `llm_profile` and contact fields | home fetch, profile hydration |
| `partnerSearchDocs` | name, tags, and the precomputed German lexemes | the kw/nm/tg ranking branches |
| `partnerEmbeddings` | the 1536-dim vector | the vector index |

Postgres could keep all three in one row because a query pays only for the
columns it `SELECT`s. **Convex reads whole documents.** The ranking path
touches up to ~100 partners per gap-fill city and needs only name/tags/lexemes;
dragging a 20 KB `llm_profile` and a 12 KB float array along would dominate the
latency being measured. The split is the Convex-idiomatic equivalent of column
projection.

`partnerSearchDocs` and `partnerEmbeddings` hold rows **only** for partners
that are active *and* have an embedding — the same predicate as
`match_partners`' `base` CTE. This is load-bearing: Convex vector-search
filters support only `eq` and `or`, never `and`, so `is_active` could not have
been a second filter field. Baking it into the population rule is how the
predicate survives.

### 2.5 `partner_intelligence` keeps its missing foreign key

Postgres has **no** FK between `partners` and `partner_intelligence`, and the
Supabase code joins manually in a second query. Reproduced faithfully:
`partnerId` is a plain number, not a `v.id("partners")`, and the join is still
manual — it just happens server-side now, inside one Convex query.

---

## 3. `match_partners` — the one hard port

The SQL builds five CTEs and fuses four with Reciprocal Rank Fusion. Mapping:

| CTE | Convex | Fidelity |
|---|---|---|
| `qraw`/`qtags` | `searchRanking.ts:expandTags` | exact — same `tagVariants` → `tagSynonyms` expansion, same empty-set guard |
| `base`/`geo` | index scan on `partnerSearchDocs.by_city_lower` | exact for the filters actually used |
| `vec` (top 40 cosine) | `ctx.vectorSearch` on `partnerEmbeddings.by_embedding` | Convex's `_score` for a cosine index **is** Postgres' `1 - (a <=> b)` |
| `kw` (ts_rank, top 40) | TypeScript over the candidate set | exact tokenizer/stopwords/stemmer + AND semantics; **ts_rank approximated** |
| `nm` (trigram > 0.25) | `convex/lib/trigram.ts` | exact pg_trgm Jaccard |
| `tg` (tag overlap > 0) | set intersection | exact |
| RRF + order + limit | `convex/lib/rrf.ts` | exact: `Σ 1/(60 + rnk)`, `order by rrf_score desc, id` |

### Why kw/nm/tg run in TypeScript rather than a Convex search index

All three CTEs are already scoped to `geo` — **one city's active partners**,
at most ~100 rows in this directory. Each needs semantics Convex's built-in
search index does not offer: German Snowball stemming with AND-of-terms
matching, pg_trgm trigram similarity, and tag-slug set overlap.

Substituting Convex's fuzzy BM25 search index would have made the Convex build
**silently better** at the `kw` branch. That sounds like a win and is actually
the failure mode this whole project has to avoid: it would return different
partners, and the latency comparison would stop being about the backend. The
lexemes are precomputed at seed time into `partnerSearchDocs` — the direct
analogue of Postgres storing `fts` as a `GENERATED` tsvector column.

### Reproduced bugs (deliberately not fixed)

Root `CLAUDE.md` §10.1–10.5 lists open defects in the Supabase retrieval path.
They are reproduced here rather than fixed, because fixing them in one build
only would invalidate the comparison:

- **`limit 40` per branch** (§10.2) — requesting `k=120` still cannot return
  more than 40 vector-scored rows.
- **`rrf_score` is returned but unused** (§10.1) — application code still reads
  only the raw cosine `similarity` and maps `null → 0`.
- **The null-embedding degrade returns nothing usable** (§10.3) — every row
  comes back with `similarity: null → 0` and is rejected by the orchestrator's
  `similarityThreshold`.
- **FTS ANDs its terms** (§10.4) — so multi-word German intents rarely hit the
  keyword branch at all. `tests/convex/sql-equivalence.test.ts` pins this.

Fix them in **both** builds, in the same commit, or in neither.

---

## 4. Known deviations

Everything below is a real difference. None of them changes which partners the
agent returns for the benchmark cases, but you should know they exist.

| # | Deviation | Impact |
|---|---|---|
| 1 | **`ts_rank` is approximated.** Postgres uses lexeme positions; the port scores each matched term by its highest section weight ({A,B,C} = {1.0, 0.4, 0.2}) with ts_rank's `w/(w+1)` saturation. | Only the rank ORDER feeds RRF, and section weight dominates it. `fts_rank` is returned but read by no application code (verified). |
| 2 | **Quoted phrases are relaxed.** `websearch_to_tsquery` turns `"a b"` into a `<->` adjacency operator; without stored positions this becomes "all these lexemes present". | No caller quotes phrases. `intentText` is free prose. |
| 3 | **`filters.near` and `filters.postal_prefix` unimplemented.** | No caller passes them. `distance_km` is always `null` — which is exactly what the Supabase caller already receives. |
| 4 | **`filters.exclude_ids` applied after the vector search**, not inside `base`. | No caller passes it. Would change which 40 rows the vector branch returns if it were used. |
| 4b | **The degenerate `vec` branch is ordered by id.** With `query_embedding = NULL`, Postgres' vec CTE still emits 40 ranked rows (`row_number() over (order by <NULL expr>)` is legal) with every `similarity` NULL. This IS reproduced — skipping it would halve the row count on the degrade path. But Postgres' order over an all-NULL expression is arbitrary scan order; the port uses id-ascending for determinism. | Only on the embedding-failure path (E25). Every one of those rows has `similarity: null → 0` and is rejected by `similarityThreshold` in both builds, so the agent-visible outcome is identical: zero borrowed partners. It does perturb the RRF order of rows that appear in BOTH vec and another branch — see the measured comparison below. |
| 5 | **Branch ties broken by partner id ascending.** Postgres' `row_number()` leaves ties unordered. | The port is *more* deterministic. Required by root `CLAUDE.md` §12.7. |
| 6 | **`get_partner_profiles.profile_data` is always `null`.** The jsonb blob is not migrated. | Read by nothing in either build. The key is kept so the row shape still matches. This is the only payload difference between the two hydration calls. |
| 7 | **Abort does not cancel server-side work.** `supabase-js .abortSignal()` aborts the fetch; `ConvexHttpClient` takes no per-call signal, so `withAbort` rejects the caller's promise while the function runs to completion. | Zero effect on measured latency — the caller returns at the same instant. A timed-out Convex call still burns its execution budget. |
| 8 | **The home fetch is one round trip, not two.** The manual `partner_intelligence` join moved server-side. | A genuine architectural difference and one of the things worth measuring. Not hidden — see §2.2. |
| 9 | **Convex vector search is approximate (ANN).** Postgres' `match_partners` does an exact scan (the HNSW index has never been used — §10.5). | At 2,331 vectors, recall should be effectively exact. Worth re-checking if the directory grows 10×. |
| 10 | **Convex functions are public.** The Supabase database was closed by RLS + a server-only service-role key. | Add auth or a shared-secret gate before exposing a deployment publicly. See SETUP.md §9. |
| 11 | **`extract_city`'s LLM extractor is retained but unused**, exactly as in the Supabase build. | Not on the live path in either. Tests and evals use it. |

---

## 4a. Measured equivalence (2026-08-12)

Both builds, same query — `match_partners(null, 'Yoga', {city: Dortmund,
tags: [yoga]}, 20)`, i.e. the text-only degrade path, which is the *least*
favourable case because it activates the arbitrary-ordering deviation 4b:

| | Postgres | Convex |
|---|---|---|
| rows returned | 20 | 20 |
| rows with `tag_overlap > 0` | 8 | 8 |
| **set of scored rows (top 11)** | `16466, 15563, 17263, 17264, 16769, 15365, 18559, 17746, 18444, 15515, 16499` | **identical set** |
| order within those 11 | — | differs (deviation 4b) |
| tail (all-NULL degenerate vec rows) | 9 rows, arbitrary order | 9 rows, id-ascending; 8 of 9 ids shared |
| `fts_rank` values | 0.7187 / 0.1655 / … | 0.5000 / 0.1667 / … (deviation 1) — same relative order |

And the full pipeline, `Bochum` + "Krafttraining für Wiedereinsteiger",
`finalRecommendations: 100`:

| | Supabase (CLAUDE.md §7, measured 2026-08-01) | Convex (measured 2026-08-12) |
|---|---|---|
| profiles rendered | 100 | 100 |
| empty profiles | 0 | 0 |
| payload | 167,456 chars / ≈41,900 tokens | **167,456 chars / ≈41,864 tokens** |

A byte-identical payload from an independently reimplemented retrieval stack is
the strongest evidence available that the two builds are doing the same work.
Re-derive both columns with `npm run convex:verify` and `npm run benchmark`.

---

## 5. Files that exist only in this build

```
convex/schema.ts              10 tables, indexes, the 1536-dim vector index
convex/cities.ts              resolve_city_fuzzy + city_centroids + coverage
convex/partners.ts            getPartnersByCity + get_partner_profiles
convex/search.ts              match_partners: the vector branch (action)
convex/searchRanking.ts       match_partners: qtags/kw/nm/tg + RRF (query)
convex/migrations.ts          clear / upsert / rebuild-aggregates / verify
convex/lib/slugify.ts         slugify_tag
convex/lib/trigram.ts         pg_trgm similarity()
convex/lib/germanFts.ts       to_tsvector('german') + websearch_to_tsquery + ts_rank
convex/lib/rrf.ts             the RRF fusion arithmetic
lib/convex.ts                 the request-path client (5 methods)
lib/convex-admin.ts           the setup-time client
scripts/export-from-supabase.ts
scripts/seed-convex.ts
scripts/verify-convex-setup.ts        (replaces scripts/verify-review-fixes.ts)
scripts/benchmark-backends.ts
tests/convex/sql-equivalence.test.ts  33 tests pinning the ported SQL semantics
```

Removed: `lib/supabase.ts`, `scripts/verify-review-fixes.ts`, and
`tests/agent-test/` (retired in the Supabase build too — it cannot execute,
since its harness reads a subagent directory that no longer exists).

`@supabase/supabase-js` moved to **devDependencies**: it is used only by the
one-time export script. The agent runtime has no Supabase dependency at all.

---

## 6. How to keep the two builds honest

1. **Change business logic in both, in the same commit.** `lib/partners/` minus
   the four data-layer files should stay diff-clean.
2. **Never fix a retrieval bug in one build only** (see §3).
3. **Keep `agent/instructions.md` and the config identical.** A prompt change in
   one build silently changes answer quality in only one arm of the experiment.
4. **Run `tests/convex/sql-equivalence.test.ts` after touching `convex/lib/`.**
   Those 33 tests are the tripwire for silent semantic drift in the ported SQL.
5. **Always read the work-performed numbers next to the latency numbers.**
   `scripts/benchmark-backends.ts` prints them side by side and refuses to
   quote a speedup when the two backends returned different result sets. Root
   `CLAUDE.md` §11 is the standing reminder of why: *the cheapest possible
   agent is one that hallucinates*, and the fastest possible backend is one
   that returns nothing.

---

## R13 (2026-08-20) — the fifth data-layer file and the sixth backend operation

The parallel-search & context architecture (plans/R13, both builds, same
commit) added home-partner relevance scoring. The scoring arithmetic lives in
`lib/partners/score-relevance.ts` and is **shared verbatim** between builds
(bitwise-identical scores by construction: 4-dp rounding, id-asc ties). Only
the embedding fetch differs per build:

- Supabase: `select id, profile_embedding from partners where id = any(ids)`
- Convex: `partners:getPartnerEmbeddings` — point-reads on
  `partnerEmbeddings.by_source_id`

`lib/partners/get-partner-embeddings.ts` is therefore the **fifth** file in
the data-layer allowance, and `ConvexBackend.getPartnerEmbeddings` is the
**sixth** backend operation. It is off the per-ranking hot path: results are
cached 24h per partner id (≈ once per city per day), and
`invalidateEmbeddingCache()` must be called alongside
`invalidateSearchCache()` after an import. Benchmark note: the first search
of a city pays one extra round-trip in both builds — keep it on the watch
list when quoting A/B numbers.
