# Navio — Convex build

Workflow **#2** in this repository: the same partner-recommendation agent as
[`../partner-recommendation-agent`](../partner-recommendation-agent), with the
Supabase/Postgres data layer replaced by **Convex**.

Its purpose is a controlled experiment. The repo's long-term goal (root
[`CLAUDE.md`](../CLAUDE.md) §2) is a bench for comparing agent architectures
against the same real dataset; this is the first sibling, and it varies exactly
one thing.

```
                      ┌─────────────────────────────────────────┐
  user message ──────▶│  eve agent · instructions.md · 2 tools  │  ← IDENTICAL
                      └──────────────────┬──────────────────────┘
                                         │
                      ┌──────────────────▼──────────────────────┐
                      │  lib/partners/  deterministic pipeline  │  ← IDENTICAL
                      │  home whole → gap-fill → cap → hydrate  │
                      └──────────────────┬──────────────────────┘
                                         │
                      ┌──────────────────▼──────────────────────┐
                      │  lib/convex.ts  ·  convex/*             │  ← THE VARIABLE
                      └─────────────────────────────────────────┘
```

---

## Start here

> **First measured result (2026-08-12):** across five cases, both builds
> returned **identical work** — same partner ids, same home+borrowed split,
> same profile payload down to the byte — and Convex was **1.8–2.2× faster** at
> p50 on the data layer (≈278 ms vs ≈521 ms for a typical Bochum search). The
> speedup is flat across stages, which points at per-round-trip overhead rather
> than query execution, and it is ~1–4% of a full agent turn once the two Azure
> model steps are counted. Full numbers and caveats: [BENCHMARKING.md](BENCHMARKING.md) §3a.

| Document | What it is |
|---|---|
| **[SETUP.md](SETUP.md)** | clean machine → running agent. Every step is a command. |
| **[MIGRATION-NOTES.md](MIGRATION-NOTES.md)** | what changed, what deliberately did not, and every known deviation |
| **[BENCHMARKING.md](BENCHMARKING.md)** | how to run both builds fairly and report the result honestly |
| **[../CLAUDE.md](../CLAUDE.md)** | the product, the data, the invariants. **Still the authority.** Read it first. |

Quick start, assuming you have the credentials listed in
[`.env.local.example`](.env.local.example):

```bash
npm install
npx convex dev          # creates the deployment, pushes the schema, writes .env.local
npm run setup           # export from Supabase → seed Convex → verify
npm run dev:ui          # http://localhost:3000
```

---

## What is identical to the Supabase build

The system prompt, the config dials, both tools, the whole `lib/partners/`
orchestration, the dev console, and the eval harness. Partner ids are preserved
(`partners.sourceId` is the original Postgres `bigint`), so both builds return
literally the same partner ids for the same request.

**Every product invariant from root `CLAUDE.md` §12 still holds**, including
the grounding mandate, home-city-whole, the single canonical path for contact
data, determinism with no `Math.random`, failure asymmetry (home hard, nearby
degrades), and the two-tool budget.

## What is different

| | Supabase | Convex |
|---|---|---|
| client | `getSupabase()` — service-role key, RLS on with no policies | `getConvex()` — deployment URL, five-method façade |
| city resolution | `resolve_city_fuzzy` RPC: pg_trgm over 2,331 rows, **no expression index** | trigram scan over a materialized ~650-row `citySpellings` table |
| city centroids | `city_centroids()` RPC, grouped per call | materialized `cityCentroids` table |
| home fetch | **two** PostgREST round trips (partners, then the manual intelligence join) | **one** Convex query |
| hybrid search | `match_partners`: one SQL statement, 4 CTEs fused by RRF | `ctx.vectorSearch` + a transactional query reproducing the other three branches |
| storage shape | one `partners` row holds text, tsvector and vector | split into `partners` / `partnerSearchDocs` / `partnerEmbeddings` by access pattern |
| aggregates | computed per call in SQL | materialized; rebuilt by a migration function |

The full rationale for each — and the eleven known deviations — is in
[MIGRATION-NOTES.md](MIGRATION-NOTES.md).

### Four pieces of Postgres had to be reimplemented in TypeScript

| Postgres | Port |
|---|---|
| `slugify_tag(t)` | [`convex/lib/slugify.ts`](convex/lib/slugify.ts) |
| `pg_trgm similarity(a, b)` | [`convex/lib/trigram.ts`](convex/lib/trigram.ts) |
| `to_tsvector('german', …)`, `websearch_to_tsquery`, `ts_rank` | [`convex/lib/germanFts.ts`](convex/lib/germanFts.ts) — full Snowball German stemmer + Postgres' German stopword list |
| the RRF fusion in `match_partners` | [`convex/lib/rrf.ts`](convex/lib/rrf.ts) |

These can drift **silently** — a stemmer that stops matching does not throw, it
just makes this build retrieve different partners than the Supabase build and
quietly voids the comparison. [`tests/convex/sql-equivalence.test.ts`](tests/convex/sql-equivalence.test.ts)
pins all four with 33 tests, and `npm run convex:verify` re-checks the stemmer
against live data.

**Known retrieval bugs are reproduced, not fixed** (root `CLAUDE.md`
§10.1–10.4): the per-branch `limit 40`, the unused `rrf_score`, the useless
null-embedding degrade path, and FTS ANDing its terms. Fixing them in one build
only would invalidate the experiment. Fix them in both, in the same commit, or
in neither.

---

## Commands

| Command | What it does |
|---|---|
| `npx convex dev` | push schema + functions, generate types, hot-reload. **Keep running while developing.** |
| `npm run setup` | export → seed → verify, in one go |
| `npm run convex:export` | Supabase → `data/export/` (needs the service-role key) |
| `npm run convex:seed` | `data/export/` → Convex (idempotent; `convex:reseed` wipes first) |
| `npm run convex:verify` | six groups of live assertions; proves the deployment is complete |
| `npm run convex:rebuild-aggregates` | rebuild the materialized city tables after a direct data edit |
| `npm run dev:ui` | Next.js dev console at http://localhost:3000 |
| `npm run dev` | eve backend only |
| `npm test` | 304 unit tests — fully mocked, **no deployment and no secrets needed** |
| `npm run typecheck` | `tsc --noEmit` — also needs no deployment |
| `npm run smoke` | live credential + pipeline smoke test |
| `npm run benchmark` | Supabase vs Convex, side by side |
| `npm run check:parity` | **run before any benchmark** — asserts both builds share one dependency tree and one set of credentials |
| `npm run sync:env` | copy shared credentials from the Supabase build (run after changing a key or model) |
| `npm run generate:coverage` | regenerate the prompt's city list. **Run after every data change.** |

`npm test` and `npm run typecheck` work without a Convex deployment on purpose:
the root `tsconfig.json` excludes `convex/` (which needs codegen), and
`lib/convex.ts` uses typed `makeFunctionReference` calls instead of the
generated API. CI stays secret-free, exactly as in the Supabase build.

---

## Layout

```
partner-recommendation-agent-convex/
├── convex/                        # THE BACKEND — the only genuinely new code
│   ├── schema.ts                  #   10 tables, indexes, the 1536-dim vector index
│   ├── cities.ts                  #   resolve_city_fuzzy · city_centroids · coverage
│   ├── partners.ts                #   getPartnersByCity · get_partner_profiles
│   ├── search.ts                  #   match_partners — the vector branch (action)
│   ├── searchRanking.ts           #   match_partners — qtags/kw/nm/tg + RRF (query)
│   ├── migrations.ts              #   clear · upsert · rebuild-aggregates · verify
│   └── lib/                       #   the four Postgres ports (see above)
├── lib/
│   ├── convex.ts                  # request-path client (5 methods)
│   ├── convex-admin.ts            # setup-time client — deliberately separate
│   └── partners/                  # UNCHANGED orchestration, Convex-typed leaves
├── agent/                         # UNCHANGED — prompt, config, 2 tools, hooks
├── app/ components/               # UNCHANGED — Next.js dev console
├── evals/                         # UNCHANGED — 10 edge cases, 14 evaluators
├── scripts/
│   ├── export-from-supabase.ts    # step 1 of the data migration
│   ├── seed-convex.ts             # step 2
│   ├── verify-convex-setup.ts     # step 3
│   └── benchmark-backends.ts      # the A/B harness
└── tests/
    └── convex/sql-equivalence.test.ts   # 33 tests pinning the ported SQL
```

---

## The rule that governs this directory

**The backend is the only variable.** Business logic changes belong in both
builds, in the same commit. `lib/partners/` minus the four data-layer files
should stay diff-clean against the Supabase build, and `agent/` should stay
diff-clean entirely. When those drift, the benchmark stops measuring the
backend and starts measuring the drift.
