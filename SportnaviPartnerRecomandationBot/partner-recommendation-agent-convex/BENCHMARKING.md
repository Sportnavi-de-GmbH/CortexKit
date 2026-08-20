# BENCHMARKING — Supabase vs Convex, side by side

How to run both builds under the same conditions and get a number you can
defend.

---

## 0. The one thing to internalise first

> **A backend that returns fewer partners is faster, and that is not a win.**

Root `CLAUDE.md` §11 documents the incident this repo exists to not repeat: a
cost optimization produced spectacular numbers — 58% cheaper, 32 s total — and
was completely wrong, because the agent had stopped querying the database and
started fabricating. Every efficiency metric improved *more* in the broken
version.

So: **every latency number in this document is only meaningful next to a
work-actually-performed number.** The harness prints both, and it refuses to
quote a speedup when the two backends returned different result sets. Do not
work around that check.

---

## 1. Prerequisites

Both projects, side by side, each installed and configured:

```
SportnaviPartnerRecomandationBot/
├── partner-recommendation-agent/          # Supabase — must already work
└── partner-recommendation-agent-convex/   # Convex — see SETUP.md
```

- Supabase build: `.env.local` + `node_modules` present, `npm run smoke` passes.
- Convex build: `npm run setup` completed, `npm run convex:verify` passes.
- **The same Azure deployment and the same embedding endpoint in both**, or you
  are comparing two different systems.
- **The same partner data in both.** The Convex data is an export of the
  Supabase data, so this holds as long as you have not re-imported the
  directory into Supabase since exporting.

Confirm all of it before anything else:

```bash
cd partner-recommendation-agent-convex
npm run check:parity     # same dependency tree AND same credentials
npm run convex:verify    # deployment fully seeded
```

`check:parity` exits 1 on drift and is not optional. Two real incidents are
why it exists:

- `package-lock.json` was deleted during scaffolding, so a fresh install
  floated `eve` 0.25.2 → 0.25.3 (the app stopped booting), plus `next`, `ai`
  and `@ai-sdk/openai` — which would have compared two different agent
  runtimes while reporting a *backend* speedup.
- The Azure deployment was changed in the Supabase build only, so the two
  builds were briefly pointing at different models.

Both were invisible to the benchmark output. `S1a` from `convex:verify` prints
the active-partner count; it must match the Supabase table.

---

## 2. The data-layer benchmark (the primary measurement)

```bash
cd partner-recommendation-agent-convex
npm run benchmark
```

Options:

```bash
npm run benchmark -- --iterations 10 --warmup 2   # more samples
npm run benchmark -- --only convex                # one backend
npm run benchmark -- --cold                       # no warm-up; cold latency
```

### What it measures

The deterministic pipeline, and only that:

```
resolveCityFuzzy  →  resolvePartners  →  buildRecommendations
```

**It does not call the LLM.** A full agent turn is dominated by two Azure model
steps costing 7–27 s (root `CLAUDE.md` §4.1); database work is a fraction of
that. Measuring end to end would bury the difference under model-latency
variance you cannot control. The backend is the only variable between the two
projects, so the backend is what gets timed.

### The fairness controls, and why each exists

| Control | Without it |
|---|---|
| **In-process caches cleared before every run** — search cache (1 h) and embedding cache | Run 2+ of a case is a memory read. Whichever backend ran second would look faster. |
| **Embeddings precomputed once per case, outside the timer, injected into both** | 200–800 ms of shared third-party HTTP noise on every sample, and two different vectors searching two different backends. |
| **Backends alternate per iteration** rather than running in blocks | A slow network minute lands entirely on one backend. |
| **Warm-up runs discarded** | Connection setup, JIT and Convex function cold-start pollute the first sample. |
| **Each build loaded from its own directory** | You would measure one project's `lib/` against the other's backend. |

**One thing is deliberately not controlled:** the 24 h city-centroid cache is a
module-level singleton with no exported invalidator in either build. It is
warmed identically by the warm-up run on both sides, so it does not favour
either — but the gap-fill numbers exclude the centroid fetch. Use `--cold` to
include it.

### The cases

| Case | City | Stresses |
|---|---|---|
| `big-city-no-gapfill` | Bielefeld | the only city with 100+ partners, so gap-fill is skipped entirely — isolates home fetch + hydration |
| `medium-city-gapfill` | Bochum | the typical request: home fetch + concurrent fan-out over ~9 cities + 100-profile hydration |
| `thin-city-wide-gapfill` | Ahlen | almost the whole shortlist is borrowed — the worst-case latency path in the product |
| `misspelled-city` | "Dormund" | fuzzy resolution: a trigram scan over ~650 materialized cities vs pg_trgm over 2,331 rows with no expression index. The misspelling must clear resolve_city_fuzzy's 0.4 floor (0.545 here) or the case measures a failed lookup instead of a fuzzy one |
| `no-tags` | Essen | no tags means the `tg` RRF branch never fires |

### Reading the output

```
── medium-city-gapfill — "Bochum" / "Kletterkurse für Anfänger"
   run 10/10
   convex   : p50   245.4 ms  p95   283.3 ms  mean   249.8 ms  | 100 recs, 30+70 resolved, 167593 chars
   supabase : p50   533.3 ms  p95   546.3 ms  mean   527.4 ms  | 100 recs, 30+70 resolved, 167593 chars
   =  identical work; convex is 2.17x faster at p50
```

- **p50** is the headline. **p95** tells you about tail latency, which is what
  a user actually feels.
- The part after `|` is the work-performed signal: recommendations returned,
  home+borrowed partners resolved, total profile characters rendered. **These
  must match across backends.**
- `⚠ WORK MISMATCH` means the two backends returned different result sets and
  the latency numbers for that case are void. Investigate before quoting
  anything — start with `MIGRATION-NOTES.md` §4.

Full results, including per-stage timings (`homeFetch`, `nearbyCities`,
`gapFill`, `overflowTrim`), land in `benchmarks/results/<timestamp>.json`.

### Where the difference comes from

Per-stage timings are where the story is. The prediction before measuring:

- **`resolveCityFuzzy`** — Postgres computes `similarity(slugify_tag(city), …)`
  over every active row with **no expression index** (root `CLAUDE.md` §6).
  Convex scans ~650 materialized city rows. Convex should win big.
- **`homeFetch`** — two PostgREST round trips vs one Convex query.
- **`gapFill`** — up to 9 concurrent hybrid searches. Postgres does the whole
  thing in one SQL statement per city; Convex does a vector search plus a query
  per city. **Postgres may well win this stage.**
- **hydration** — one batched call on both sides; largely a payload-size
  contest, and the payloads are deliberately identical.

The first measured run (§3a) says something different from all of that: the
speedup is ~2.0–2.5× on *every* stage, including the trivial ones. Flat ratios
across stages of very different query complexity point at per-round-trip
overhead rather than query execution. Read §3a before drawing conclusions.

---

## 3. The end-to-end benchmark (optional, noisier, more realistic)

If you want the number a user experiences, run the eval harness against each
build and compare LangSmith latency.

```bash
# terminal 1
cd partner-recommendation-agent        && npx tsx evals/run-experiment.ts
# terminal 2 (after the first finishes — do NOT run concurrently)
cd partner-recommendation-agent-convex && npx tsx evals/run-experiment.ts
```

Both builds share the `evals/` harness (10 edge cases, 14 evaluators), so this
also compares **answer quality**, not just speed — which matters, because
quality is priority #1 in the repo's ranking and speed is #2.

Set a different `LANGSMITH_PROJECT` per build, or the traces mix.

Caveats:

- Two Azure model steps per search dominate; expect the backend difference to
  be a few percent of the total and easily lost in variance. Run enough
  iterations.
- Run them **sequentially**. Concurrent runs contend for the same Azure
  deployment quota and both get slower.
- Watch `app.model_steps`: **2** for a search, **1** otherwise. A **4** means
  the old three-tool chain came back and the run is invalid.
- LangSmith cost figures are inflated ~8× in both builds (root `CLAUDE.md` §9).
  Treat them as a relative signal only.

---

## 3a. First measured result (2026-08-12)

`npm run benchmark -- --iterations 8 --warmup 2`, from a client in Europe
against a Convex deployment in `eu-west-1` and the existing Supabase project.
**Every case reported identical work** — same recommendation count, same
home+borrowed split, same profile payload down to the byte.

Re-run after the dependency trees were brought back into parity, so both
builds are on eve 0.25.2 / next 15.5.20 / ai 7.0.31.

| Case | Supabase p50 | Convex p50 | Speedup | Work (recs / home+borrowed / chars) |
|---|---|---|---|---|
| `big-city-no-gapfill` (Bielefeld) | 322.5 ms | 179.7 ms | **1.79×** | 100 / 100+0 / 174,859 |
| `medium-city-gapfill` (Bochum) | 521.4 ms | 277.5 ms | **1.88×** | 100 / 30+70 / 167,593 |
| `thin-city-wide-gapfill` (Ahlen) | 511.2 ms | 261.6 ms | **1.95×** | 92 / 21+71 / 153,678 |
| `misspelled-city` ("Dormund") | 538.2 ms | 250.9 ms | **2.15×** | 93 / 56+37 / 149,417 |
| `no-tags` (Essen) | 511.7 ms | 258.7 ms | **1.98×** | 81 / 48+33 / 125,589 |

An earlier run of the same five cases reported 2.17–2.40×. The work columns
were byte-identical in both runs; the spread is ordinary run-to-run variance
on a shared network, which is itself a useful calibration: **treat anything
under ~1.3× as noise at this sample size.**

Per stage (mean ms), which is where the story actually is:

| Case | Stage | Supabase | Convex | Speedup |
|---|---|---|---|---|
| Bielefeld | resolveCityFuzzy | 120.9 | 49.1 | 2.46× |
| | resolvePartners | 166.7 | 66.0 | 2.53× |
| | buildRecommendations | 154.7 | 61.8 | 2.50× |
| Bochum | resolveCityFuzzy | 109.0 | 44.9 | 2.43× |
| | resolvePartners | 288.8 | 136.2 | 2.12× |
| | buildRecommendations | 129.5 | 68.7 | 1.89× |
| Ahlen | resolveCityFuzzy | 112.4 | 48.2 | 2.33× |
| | resolvePartners | 294.5 | 129.5 | 2.27× |
| | buildRecommendations | 123.1 | 56.6 | 2.17× |

### How to read this

The speedup is remarkably **flat across stages** — roughly 2.0–2.5× everywhere,
including `resolveCityFuzzy`, which is a single round trip doing very little
work on either side. That flatness is the tell: this is dominated by
**per-round-trip overhead**, not by query execution. Convex's HTTP/function
path is simply cheaper per call than PostgREST's for this workload and these
two network positions.

Consequences for how much weight to put on it:

- It is **not** evidence that Convex's query engine beats Postgres'. The
  gap-fill stage (9 concurrent hybrid searches, the most database-heavy thing
  the agent does) shows 2.1–2.3×, the *same* ratio as the trivial city lookup.
  If query execution were the differentiator, those numbers would diverge.
- It **is** evidence that for this agent's access pattern — many small,
  latency-sensitive round trips — Convex is materially faster end to end.
- Round-trip count also changed in Convex's favour by design: the home fetch is
  one query instead of two (`MIGRATION-NOTES.md` §2.2). That is a legitimate
  part of the result, not a thumb on the scale, but it is a *port* difference
  rather than a *platform* difference.
- **Network position is uncontrolled.** Both backends are remote, but not
  equidistant. Re-run from a host near the Supabase region before treating the
  ratio as a platform property.

In the full agent turn, two Azure model steps cost 7–27 s, so saving ~290 ms of
database time is roughly a **1–4% end-to-end improvement**. Worth having, not
transformative. Use §3 if you need the end-to-end number.

---

## 4. Reporting a result honestly

A defensible write-up says all of this:

1. **Both work signals matched** for every case quoted (or which ones did not).
2. **Iterations and warm-up** used, and whether `--cold` was set.
3. **p50 and p95**, not just the mean — a backend with a good mean and a bad
   tail is worse for users.
4. **Per-stage breakdown**, because "Convex is 1.5× faster" is much less useful
   than "city resolution is 6× faster, gap-fill is 1.1× slower".
5. **Which deployment region** the Convex deployment is in, and where you ran
   the client from. A hosted Convex deployment on another continent will lose
   to a nearby Supabase project for reasons that have nothing to do with either
   database.
6. **That the data-layer benchmark excludes the LLM**, and roughly what
   fraction of a real turn it represents.
7. **The date and the row counts** — 2,333 partners across 649 cities is a
   small dataset, and both systems behave differently at 10×.

### What this benchmark cannot tell you

- **Scaling behaviour.** At 2,333 rows, Postgres never touches its HNSW index
  and Convex's vector search is effectively exact. Both change at scale, in
  different directions.
- **Cost.** Different pricing models entirely. Convex bills function calls,
  bandwidth and storage; Supabase bills compute and storage.
- **Answer quality.** Use the eval harness (§3). Retrieval was reproduced as
  faithfully as possible (`MIGRATION-NOTES.md` §3), but §4 lists real
  deviations — `ts_rank` is approximated and Convex's ANN vector search is not
  guaranteed exact.
- **Operational cost of the two models.** The Convex build needs an aggregate
  rebuild after every data import; the Supabase build does not. That is a real
  cost that no latency number captures.
