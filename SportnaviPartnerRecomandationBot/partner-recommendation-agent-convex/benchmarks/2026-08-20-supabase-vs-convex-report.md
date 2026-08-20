# Supabase vs Convex — measured comparison (2026-08-20)

Per BENCHMARKING.md §4. Client: Windows workstation, Europe. Convex deployment:
`eu-west-1` (`hardy-lark-977`). Same Azure deployment, same embedding endpoint,
dependency and credential parity verified (`npm run check:parity`), deployment
seeding verified (`npm run convex:verify`, all PASS). R13 config active
(minPartners 12, knee-cut shortlist, 12-profile hydration). Dataset: 2,333
partners / 649 cities. Data-layer only — no LLM (a real turn adds two Azure
model steps at 7–27 s).

**Pre-measurement fix:** the Convex deployment was missing the R13 function
`partners:getPartnerEmbeddings` (relevance scoring silently degraded to
unranked). `npx convex dev --once` pushed the current functions; verify re-ran
clean. Without this the two backends would have been doing different work.

## Warm — `npm run benchmark -- --iterations 10 --warmup 2`

Raw samples: `results/2026-08-20T11-12-15-584Z.json`.

| Case | Supabase p50 / p95 | Convex p50 / p95 | Speedup p50 | Work (matched) |
|---|---|---|---|---|
| big-city-no-gapfill (Bielefeld) | 440.8 / 484.7 | 248.3 / 308.7 | **1.78×** | 3 recs, 100+0, 6,534 chars |
| medium-city-gapfill (Bochum) | 439.7 / 453.0 | 234.9 / 244.9 | **1.87×** | 12 recs, 30+10, 21,790 chars |
| thin-city-wide-gapfill (Ahlen) | 414.2 / 434.1 | 224.1 / 248.8 | **1.85×** | 12 recs, 21+10, 19,783 vs 19,795 chars ⚠ |
| misspelled-city ("Dormund") | 443.1 / 461.7 | 236.8 / 272.7 | **1.87×** | 12 recs, 56+11, 23,101 chars |
| no-tags (Essen) | 393.2 / 421.3 | 231.3 / 241.0 | **1.70×** | 12 recs, 48+7, 20,570 chars |

⚠ Ahlen: 12-char profile-payload deviation (counts and splits identical) —
consistent with the ANN-vs-exact deviation in MIGRATION-NOTES §4. Negligible;
watch it.

## Cold — `npm run benchmark -- --iterations 6 --cold`

Raw samples: `results/2026-08-20T11-12-58-634Z.json`.

| Case | Supabase p50 / p95 | Convex p50 / p95 | Speedup p50 |
|---|---|---|---|
| Bielefeld | 458.7 / **961.1** | 308.7 / 516.3 | 1.49× |
| Bochum | 442.9 / 662.2 | 243.6 / 414.1 | 1.82× |
| Ahlen | 411.2 / 619.9 | 236.6 / 339.5 | 1.74× |
| "Dormund" | 448.7 / 686.2 | 238.3 / 440.7 | 1.88× |
| Essen | 413.0 / 679.8 | 260.4 / 357.0 | 1.59× |

## Multi-search — 3 concurrent searches, one tool call (R13 path)

Bochum + Ahlen + Essen via `Promise.allSettled`, 8 iterations, 1 warm-up, same
fairness controls (ad-hoc script mirroring the harness loader).

| Backend | p50 | p95 | mean | Work |
|---|---|---|---|---|
| Supabase | 567.0 ms | **1274.3 ms** | 697.7 ms | 36 recs / 62,143 chars |
| Convex | 266.1 ms | 358.5 ms | 281.8 ms | 36 recs / 62,155 chars |

Convex absorbs 3× concurrency at single-search latency (266 vs 235 ms p50);
Supabase degrades 1.3× at p50 and ~3× at p95. **2.13× p50 / 3.56× p95.**

## Per-stage (warm mean, 5-case average, ms)

| Stage | Supabase | Convex | Ratio |
|---|---|---|---|
| resolveCityFuzzy | 106.8 | 50.7 | 2.11× |
| resolvePartners | 250.2 | 132.2 | 1.89× |
| buildRecommendations | 69.5 | 54.6 | 1.27× |

Flat ~2× ratio across stages of very different complexity → the win is
per-round-trip overhead (plus the 2→1 home-fetch port difference), not query
execution. Hydration — payload-bound, not round-trip-bound — is near parity
under R13's 12-profile shortlist.

## Honest-reporting checklist (§4)

1. Work signals matched everywhere except the 12-char Ahlen deviation above.
2. Warm: 10 iter / 2 warm-up. Cold: 6 iter, `--cold`. Multi: 8 iter / 1 warm-up.
3. p50 and p95 quoted throughout.
4. Per-stage breakdown above.
5. Convex `eu-west-1`; client in Europe; Supabase region **not independently
   verified this run** — network position uncontrolled, re-run near the
   Supabase region before treating the ratio as a platform property.
6. LLM excluded; data layer is ~2–6% of a real turn (~430 ms vs ~7–27 s).
7. 2026-08-20; 2,333 partners / 2,331 active / 649 cities. Both systems behave
   differently at 10× the data (Postgres HNSW unused; Convex ANN not exact).

## Conclusion

On performance, Convex wins this workload: ~1.8× p50 single-search, 2.1–3.6×
under concurrent multi-search, materially tighter cold tails, identical
results. In a real turn that is ~0.2 s (single) to ~0.9 s (multi-search p95)
of a 7–27 s response — perceptible mainly in multi-search turns and tails.
Priority levers if staying on Supabase: expression index for
`resolve_city_fuzzy` (~107 ms flat per search), merge the home fetch into one
RPC, investigate PostgREST connection reuse under fan-out. Either way, the
biggest real-time lever remains the two Azure model steps, not the database.
