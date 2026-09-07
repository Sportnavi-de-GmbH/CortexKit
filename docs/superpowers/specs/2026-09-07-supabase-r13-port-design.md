# Supabase R13 port — design and comparison

**Date:** 2026-09-07
**Goal:** a second partner agent, `SportnaviPartnerRecomandationBot/partner-recommendation-agent-supabase/`,
that behaves like the Convex build (`partner-recommendation-agent-convex/`, the reference)
in every user-visible way, but reads from Supabase/Postgres.

**Hard constraints (from the owner):**
- The Convex build is the source of truth and is **not touched**. Not one file.
- The retired Supabase build (`partner-recommendation-agent/`) is also left as is.
- The new build has its own `.env.local`, its own port, its own `node_modules`.
- Verification = typecheck + unit tests + a live smoke; every non-identical behaviour is documented.

## 1. Comparison — Convex reference vs retired Supabase build

| # | Area | Convex build (reference, 2026-08-20) | Retired Supabase build | Gap the port closes |
|---|---|---|---|---|
| 1 | Architecture | eve 0.25.2 agent, Next dev console, 2 tools, R13 parallel-search pipeline (resolve, then gap-fill in parallel with home-relevance scoring, then rank, then hydrate) | same eve/Next skeleton, pre-R13 sequential pipeline | port the R13 pipeline unchanged |
| 2 | Data access | one facade `lib/convex.ts` exposing a 6-method `ConvexBackend` interface; `lib/partners/*` never see a client type | `SupabaseClient` passed around; each file builds its own PostgREST query | same 6-method interface, implemented over PostgREST/RPC |
| 3 | Search + ranking | `search:matchPartners` (Convex port of the `match_partners` RPC) + `score-relevance.ts` (home relevance, 4-dp, id-asc ties) + `relevanceCutoffCount` | `match_partners` RPC only; no home relevance scoring | keep the **original** `match_partners` RPC (exact, not ANN) + port `score-relevance.ts` verbatim |
| 4 | Embeddings / vector | `partnerEmbeddings` table, Convex ANN vector index, `getPartnerEmbeddings` point reads | `partners.profile_embedding` (pgvector, exact scan inside `match_partners`) | read `profile_embedding` for the R13 scoring; vector search stays inside the RPC |
| 5 | Prompts | `agent/instructions.md` (R13 version) + `agent/instructions/002-city-coverage.md` | older prompt, 400 lines different | copy the reference prompt byte-for-byte |
| 6 | Recommendation logic | `partner-injection.config.ts` R13 dials, `build-recommendations.ts`, `render-context.ts` tier 1/2, `grounding-check.ts` | older dials (148 lines different) | copy verbatim |
| 7 | Langfuse / observability | Langfuse OTLP (root CLAUDE.md 16.3b contract) + feedback scores + annotation queue + LangSmith + Sentry on one OTel provider | Langfuse port half-done and **uncommitted** | copy the reference wiring; only the knowledge-source strings and the `FAILURE_PATTERNS` classifier change wording (Convex to Supabase) |
| 8 | Config / env | `NEXT_PUBLIC_CONVEX_URL`/`CONVEX_URL` + Azure + embeddings + Langfuse (+ Supabase for export only) | `MEMORY_SUPABASE_URL` + `MEMORY_SUPABASE_SERVICE_ROLE_KEY` + Azure + embeddings + Langfuse | new `.env.local` with the Supabase pair, no Convex vars, own `LANGSMITH_PROJECT`, own port (3006) |
| 9 | API endpoints | `/eve/v1/*` (channel auth: size cap, then Basic shared secret), `POST /api/feedback` | same | copy verbatim |
| 10 | Tests / evals | 28 vitest files incl. `tests/convex/sql-equivalence.test.ts`, evals harness (`evals/*`), `scripts/verify-langfuse.ts`, `scripts/smoke-live.ts`, `scripts/verify-convex-setup.ts` | 24 vitest files, older `fakeSupabase` Proxy | carry every Convex test that is backend-agnostic; replace the Convex-only ones with Supabase-adapter tests |

### Behaviour that will NOT be identical (by construction; kept current in the new build's `PARITY-NOTES.md`)

| # | Difference | Why | User-visible? |
|---|---|---|---|
| A | `match_partners` runs the **exact** Postgres scan with real `ts_rank`; Convex approximates `ts_rank` and uses ANN | Convex deviations 4.1/4.9 are Convex's approximations of Postgres, so the Supabase side is the original | no measurable change at 2.3k partners (Convex MIGRATION-NOTES 4a) |
| B | `profile_data` is populated on Supabase, always null on Convex | Convex did not migrate the jsonb blob | no; read by nothing |
| C | Aborting a stage cancels the HTTP request on Supabase (`.abortSignal`); Convex runs to completion | client capability | no |
| D | `getPartnersByCity` is **two** round trips on Supabase (partners + manual `partner_intelligence` join), one on Convex | no FK in Postgres | latency only |
| E | Supabase functions are **not** public (RLS + service-role key); Convex functions are public (R11) | platform | security posture is better on Supabase |
| F | PostgREST caps unbounded selects at 1,000 rows silently | platform | every unbounded read is paged or an RPC; the only per-request table reads are per-city (up to ~100 rows) and per-id lists |
| G | City resolution ties: Postgres leaves full ties unordered; Convex breaks them by city name | SQL | practically never (a full tie needs identical similarity AND identical partner count) |

## 2. Approaches considered

1. **Copy the Convex build, swap the data facade** (chosen). `lib/partners/*` stay byte-identical except one import line, so future syncs from the reference are a mechanical diff. The old build's proven PostgREST/RPC calls become the six facade methods.
2. Upgrade the retired build in place. Rejected: the owner wants it untouched, and it carries an unfinished Langfuse port with uncommitted edits.
3. One build with a runtime `DATA_BACKEND` switch. Rejected: the owner asked for a separate, independent project, and a switch would also require editing the Convex build.

## 3. Design

### 3.1 Folder
`SportnaviPartnerRecomandationBot/partner-recommendation-agent-supabase/` is a full copy of the Convex
build **minus** `convex/`, `benchmarks/`, `node_modules/`, `.next/`, `.eve/`, `.data/`, `.env.local`,
`tsconfig.tsbuildinfo`, and the Convex-only scripts. It gets its own `npm install`.

### 3.2 Data facade: `lib/supabase.ts`
Same shape as `lib/convex.ts`, renamed 1:1 (`ConvexBackend` becomes `SupabaseBackend`, `getConvex()` becomes
`getSupabase()`, `ConvexXxxRow` becomes `SupabaseXxxRow`, `resetConvexClient()` becomes `resetSupabaseClient()`).
One lazily-built, cached `SupabaseClient` from `MEMORY_SUPABASE_URL` + `MEMORY_SUPABASE_SERVICE_ROLE_KEY`
(service role is mandatory: RLS with no policies makes the anon key return zero rows silently).

| Method | Supabase call | Notes |
|---|---|---|
| `resolveCityFuzzy(place)` | `rpc("resolve_city_fuzzy", { place })`, then `rows[0] ?? null` | RPC already applies the 0.4 floor and `limit 1` |
| `getPartnersByCity({aliases, tagFilter, includeInactive})` | `from("partners").select(8 cols).in("city", aliases)` [+ `.eq("is_active", true)`] [+ `.overlaps("tags_norm", tagFilter)`], dedupe by id, then best-effort `from("partner_intelligence").select("partner_id, quality_score").in("partner_id", ids)` | the retired build's code, moved behind the interface |
| `cityCentroids()` | `rpc("city_centroids")` | server-side aggregate, no 1,000-row cliff |
| `matchPartners({queryEmbedding, queryText, filters, matchCount})` | `rpc("match_partners", { query_embedding, query_text, filters: { city, tags?, exclude_ids? }, match_count })` | key names translated camel to snake exactly once, here |
| `getPartnerProfiles(ids)` | `rpc("get_partner_profiles", { p_ids: ids })` | 13 columns incl. `profile_data` |
| `getPartnerEmbeddings(ids)` | `from("partners").select("id, profile_embedding").in("id", ids).not("profile_embedding", "is", null)`, then parse the pgvector string to `number[]` and assert 1536 dims | the R13 read; cached 24 h by the caller |

Every method honours `opts.signal` via `.abortSignal()`. Every method is `async` so a missing env var
becomes a rejection, not a synchronous throw (the gap-fill fan-out holds promises before awaiting).

### 3.3 Everything else
- `lib/partners/*`, `agent/*`, `app/*`, `components/*`, `lib/langfuse.ts`, hooks, channel, feedback: copied. Only
  the import line and identifier rename change, plus Convex-specific wording in `PARTNER_AGENT_ROLE`,
  `PARTNER_KNOWLEDGE_MODE`, `PARTNER_KNOWLEDGE_SOURCE`, `app.knowledge.mode`, and the two Convex
  `FAILURE_PATTERNS` entries (which become Supabase/PostgREST patterns).
- `scripts/`: keep `verify-langfuse`, `check-feedback`, `setup-feedback-scores`, `live-check`, `load-test`,
  `verify-langsmith`, `verify-sentry`. Port `smoke-live` (stage 1 = Supabase row counts) and
  `generate-city-coverage` (paged `partners` scan from the retired build). Add `verify-supabase-setup`
  (S1 to S6: reachable, row count, each RPC answers, embedding dims, intelligence rows, coverage file fresh).
  Drop `export-from-supabase`, `seed-convex`, `verify-convex-setup`, `benchmark-backends`,
  `sync-shared-env`, `check-dep-parity`.
- `package.json`: name `supabase-partner-agent`, `@supabase/supabase-js` becomes a runtime dependency,
  `convex` removed, scripts trimmed to match.
- `tests/`: all backend-agnostic tests carried; `tests/tools/_fakes.ts` becomes `fakeSupabase()` over the
  same interface; `tests/lib-env-guards.test.ts` asserts the Supabase env names; `tests/convex/` dropped;
  new `tests/supabase-backend.test.ts` checks the camel-to-snake argument mapping, the pgvector string parse,
  the abort wiring and the two-query intelligence join against a stubbed client.
- Docs: `README.md`, `SETUP.md`, `PARITY-NOTES.md` (the table above, kept current), `CLAUDE.md` for the folder.

### 3.4 Isolation checks
- Port **3006** (3001 widget, 3002 Docker, 3003 orchestrator, 3005 Convex).
- Own `.env.local`, created by copying credentials from the retired build's file (same Supabase project,
  same Azure/embedding endpoints, same "Navio - Partner" Langfuse keys, which both partner builds already share),
  `LANGSMITH_PROJECT=Navio Partner-supabase`. Never written by any script.
- No file outside the new folder changes except this spec.

### 3.5 Verification
1. `npm run typecheck` and `npm test` green in the new folder (apart from the one pre-existing prompt-wording
   assertion the reference build also fails, if the copied prompt carries it).
2. Convex build still green: baseline captured before any change (typecheck clean, 452/453), re-checked after.
3. `npm run supabase:verify` against the live project.
4. `npm run smoke` (live pipeline for one query) if credentials allow.
5. Widget-level check is out of scope for this pass; it needs `PARTNER_AGENT_HOST` flipped, which the owner
   said not to change.
