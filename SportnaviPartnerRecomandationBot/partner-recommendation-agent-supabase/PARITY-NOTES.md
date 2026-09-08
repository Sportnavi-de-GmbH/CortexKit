# PARITY NOTES — this build vs the Convex reference

**Reference:** `../partner-recommendation-agent-convex` (R13, adopted as Navio's partner agent 2026-08-20).
**This build:** the same agent with its data layer pointed back at the original Supabase/Postgres project.
**Created:** 2026-09-07. Keep this file current whenever either build changes.

The rule that makes the two builds comparable: **everything above the data facade is the
reference's code.** `lib/partners/*`, `agent/*`, `app/*`, `components/*`, the Langfuse/LangSmith/
Sentry wiring, the feedback system, the channel auth, the prompt, the config dials — all copied
from the reference with one mechanical rename (`ConvexBackend` → `SupabaseBackend`, `getConvex()` →
`getSupabase()`, the `convex` dependency-injection parameter → `supabase`). Diff the two folders
and that rename is what you see, plus the files listed in §3.

---

## 1. What is identical (by construction)

| Area | Status |
|---|---|
| R13 parallel-search pipeline (`resolve-partners.ts`, `score-relevance.ts`, `get-partner-embeddings.ts`, `build-recommendations.ts`, `render-context.ts`, `grounding-check.ts`, `search-cache.ts`) | byte-identical except the import line and the injected parameter name |
| System prompt `agent/instructions.md` + `agent/instructions/002-city-coverage.md` | byte-identical (copied from the reference's **working tree**, which carries an uncommitted edit; see §4) |
| Config dials `agent/config/partner-injection.config.ts` | byte-identical |
| The two tools (`find_partners`, `get_partner_details`) and the 10 disabled built-ins | identical except the facade import |
| Request budget, timeouts, model limits, agent definition, session limits | identical |
| Langfuse trace contract (span names, attributes, feedback scores, annotation queue), LangSmith, Sentry | identical wiring; only the knowledge-source **wording** says "Supabase" and the two directory `FAILURE_PATTERNS` match PostgREST errors instead of Convex ones |
| `/eve/v1/*` channel auth (size cap → Basic shared secret), `POST /api/feedback` | identical |
| Dev console (Next app + components) | identical |
| Unit tests | every backend-agnostic test carried unchanged; the fake backend has the same six methods |

## 2. Where the SAME interface is served differently

The six `SupabaseBackend` operations and their Postgres counterparts (`lib/supabase.ts`):

| Operation | Convex reference | This build |
|---|---|---|
| `resolveCityFuzzy` | trigram scan over the materialized `citySpellings` table | `resolve_city_fuzzy(place)` RPC — the original SQL |
| `getPartnersByCity` | one query with an in-function `partnerIntelligence` join | `partners` select + a second best-effort `partner_intelligence` select (no FK exists, so no PostgREST embed) |
| `cityCentroids` | one read of the materialized `cityCentroids` table | `city_centroids()` RPC — a server-side GROUP BY |
| `matchPartners` | `search:matchPartners` action — a TypeScript port of the RPC with approximated `ts_rank` and an ANN vector index | `match_partners(...)` RPC — the original, exact scan |
| `getPartnerProfiles` | `partners:getPartnerProfiles`, `profile_data` always `null` | `get_partner_profiles(p_ids)` RPC — all 13 columns real |
| `getPartnerEmbeddings` | point reads on `partnerEmbeddings.by_source_id` | `select id, profile_embedding from partners where id in (…)`, pgvector text decoded in `decodeVector()` |

## 3. Behaviour that is NOT identical — and cannot be made identical

| # | Difference | Why it cannot be closed | User-visible? |
|---|---|---|---|
| A | **Search ranking is the original, not the approximation.** `match_partners` computes real `ts_rank` (lexeme positions) and an exact cosine scan; the Convex port approximates `ts_rank` by section weight and uses ANN. | The Convex side is an approximation *of this side*. Measured equivalent on the benchmark cases (reference MIGRATION-NOTES §4a); if the directory grows 10×, the ANN side is the one to re-check. | No. Only rank order feeds RRF; no code reads `fts_rank`. |
| B | **Branch ties.** Postgres `row_number()` leaves ties inside a branch unordered; the Convex port breaks them by partner id. | SQL does not promise an order for ties. | Only on exact ties; practically never. |
| C | **City-resolution full ties.** Same as B for `resolve_city_fuzzy`'s `order by sim desc, count(*) desc limit 1`. | SQL. | A full tie needs identical similarity AND identical partner count. |
| D | **Abort cancels server work here.** supabase-js `.abortSignal()` aborts the fetch, so a timed-out stage stops costing anything; the Convex HTTP client runs the function to completion. | Client capability. | No. The caller returns at the same instant in both. |
| E | **`getPartnersByCity` is two round trips**, not one. | No foreign key between `partners` and `partner_intelligence`, so PostgREST cannot embed. | Latency only (measured ~145 ms for Bochum, 30 rows). |
| F | **`profile_data` is populated.** | The Convex migration skipped the jsonb blob. | No. Read by nothing in either build. |
| G | **Security posture.** RLS + a server-only service-role key close the database; the Convex deployment's functions are public (upstream R11 blocker). | Platform. | Better here. Do not expose the service-role key. |
| H | **PostgREST's silent 1,000-row cap.** Any unbounded `select` returns at most 1,000 rows with no error. | Platform. | Every unbounded read is an RPC or paged; the only per-request table reads are per-city (≤ ~100 rows) and per-id lists. `scripts/generate-city-coverage.ts` pages and cross-checks an exact count. |
| I | **`filters.exclude_ids`** is applied inside the SQL `base` CTE here, after the vector search on Convex. | Documented Convex deviation. | No caller passes it. |

## 3b. DELIBERATE PROMPT DIVERGENCE — this build leads, 2026-09-08

**Golden rule 1 ("the reference wins") is suspended for `agent/instructions.md`.** The owner
directed the Navio widget's button/redirect work at THIS build, because
`kb-agent-langsmith-starter/.env.local` has `PARTNER_AGENT_HOST=http://127.0.0.1:3006` — the
Supabase build is what actually answers. So the prompt was extended here first, and the Convex
build does not have these sections yet.

**Do NOT re-copy `agent/instructions.md` from the Convex build** without porting these forward,
or the widget's buttons silently stop appearing (an unknown or absent marker is dropped without
error — see `tests/marker-contract.test.ts`).

What is new here and missing there:

| Section | What it does |
|---|---|
| `## Not your question — hand it to the FAQ agent` | Sportnavi-topic questions (tariffs, cancellation, check-in, cashback, Firmenfitness…) are handed to the FAQ agent instead of guessed at, via `[[action:faq-agent]]`. |
| `## The marker line — buttons and the freshness notice` | The `[[action:…]]` / `[[notice:data]]` vocabulary the widget renders as buttons and the amber callout. |
| Closing block of `## Presenting recommendations` | "Current details always come from the studio itself" (hours/prices/availability, once per message) + emit `[[notice:data]]` whenever partners were named. |

**Prompt versioning** now mirrors the widget build: authored versions live in `agent/prompts/`
(`instructions-v1.md` = the pre-buttons prompt, `instructions-v2.md` = live), `agent/instructions.md`
is the active copy, and `npm run prompt:use v1|v2` switches. Never hand-edit `agent/instructions.md`
— that edit is what the next switch overwrites.

The widget half of the contract is `kb-agent-langsmith-starter/lib/navio-actions.ts`
(`NAVIO_ACTION_IDS`, `NAVIO_NOTICE_IDS`, `ALWAYS_ACTIONS`). The two services deploy separately so
there is nothing to import; `tests/marker-contract.test.ts` duplicates the ids and fails loudly if
this prompt drifts off them.

## 4. Known inherited state

- **One unit test fails in both builds:** `tests/agent-assembly.test.ts › keeps contact details bound
  to the grounding mandate` expects the phrase *"Copy contact details \*exactly\*"*, which the
  reference's **uncommitted** working-tree edit of `agent/instructions.md` removed. This build copies
  that working-tree prompt verbatim, so it inherits the failure (439/440 here, 452/453 there — the
  other 13 tests are `tests/convex/sql-equivalence.test.ts`, Convex-only, dropped). Fix it in the
  reference first, then re-copy the prompt.
- `lib/partners/*` file headers still say "CONVEX PORT of the Supabase build's file" — those
  comments are the reference's, kept verbatim so the files stay diffable. The facade this build uses
  is `lib/supabase.ts`.

## 5. How to keep the two builds honest

1. Any change to `lib/partners/*`, `agent/*`, config or prompt is made in the **reference** and copied
   here (`diff -r` the two trees; only the rename and the §3 files should differ).
2. `npm run supabase:verify` (S1–S6) after any database change; `npm run smoke` for the pipeline.
3. Run both unit suites; the pass/fail sets must match modulo the Convex-only tests.
4. Re-run `npm run generate:coverage` in **both** builds after a partner import — the coverage list is
   baked into the prompt.

## 6. Feedback quality loop (2026-09-08)

This build carries the full feedback→improvement workflow, byte-mirrored from the widget
(`kb-agent-langsmith-starter`): `lib/feedback-taxonomy.ts` (shared reason + review-verdict
vocabulary), `lib/feedback-insights.ts` (pure stats/promote routing), positive-queue routing in
`lib/feedback.ts` (👍-with-comment → "Feedback — Positive Examples"), and the
`feedback:setup` / `feedback:report` / `feedback:promote` scripts (script copies here import
`../lib/...` without the `.ts` extension — this tsconfig forbids it; that is the only diff).
Operating manual: `../../kb-agent-langsmith-starter/docs/FEEDBACK-SYSTEM.md` (rituals, env-id
table for BOTH projects, live-instance traps). The **Convex reference does not have this yet** —
when it is next touched, copy these files there per §5, adjusting imports the same way.
