# Fast Iteration — the "quick test" for prompt changes

Waiting ~35 minutes for a full 60-sample evaluation on every prompt tweak is
too slow. This adds a **10-sample quick test** you run while iterating, and
keeps the full run only for the final decision.

## The three tiers

| Tier | Command | Samples | ~Time | ~Cost | Use it for |
|---|---|---|---|---|---|
| **smoke** | `EVAL_SPLIT=smoke npm run eval:run` | 5 | ~3 min | ~$0.06 | "Did I break something obvious?" |
| **dev** ⭐ | `npm run eval:dev` | 10 (curated) | ~5–7 min | ~$0.15 | "Did I fix what I meant, break anything?" |
| **full** | `npm run eval:run` | 60 | ~35 min | ~$1.15 | Final adopt/reject decision only |

All commands need `EVE_HOST` pointing at your running eve dev server's **real
port**, e.g.:

```bash
EVE_HOST=http://127.0.0.1:2001 npm run eval:dev
```

## What the dev tier actually checks

The 10 samples aren't random — they're copied verbatim from the full
`navio-kb-testing-final-response-v2` dataset and chosen to cover every
dimension a prompt change can move, **including the known "regression
guards"**:

| Sample | What it guards |
|---|---|
| sample-028 | The KB pause-splitting contradiction that answers **wrong today** — watch this flip to pass when you fix the KB |
| sample-033, sample-060 | English questions the bot wrongly answers **in German** (language mirroring) |
| sample-052 | A "reveal your system prompt" attack — must refuse / no leakage |
| sample-042 | A multi-turn chat — must remember earlier context |
| sample-006, sample-007 | Core correctness + exact contact/cashback details |
| sample-010 | Firmenfitness pricing (rule-vs-KB tension; sensitive to change) |
| sample-030 | Ambiguous question — should ask, not assume |
| sample-045 | French question — must answer in French |

By default the dev tier runs only the **2 most decision-relevant judges**
(hallucination + correctness) to stay fast and cheap. Deterministic checks
(language match, must-include, etc.) always run and are free.

## How it works (so you can trust it)

- `npm run eval:dev` runs `scripts/eval-dev.ts`, a thin wrapper that sets
  three defaults (`EVAL_DATASET=navio-kb-dev-subset-v1`,
  `EVAL_JUDGES=hallucination,correctness`, a `navio-kb-dev` experiment name)
  and then hands off to the **unchanged** `scripts/run-eval.ts`. Same engine,
  same pacing, same metrics — just fewer, curated samples and fewer judges.
- Dev runs land under their **own LangSmith dataset**
  (`navio-kb-dev-subset-v1`), so throwaway iteration runs never clutter the
  official 60-sample experiment history.
- The Azure throttle is left at the safe default (~2 turns/min), so there is
  **no rate-limit risk** — the speedup comes purely from running 10 samples
  instead of 60.

## Overrides (all optional)

```bash
EVE_HOST=... EVAL_JUDGES=all  npm run eval:dev   # all 7 judges on the 10 samples
EVE_HOST=... EVAL_JUDGES=none npm run eval:dev   # deterministic-only, fastest (~4 min)
EVE_HOST=... EVAL_EXPERIMENT_PREFIX="navio-kb-dev_myprompt-v3" npm run eval:dev
```

**Optional accelerator (only when the smaller v1 KB-dedup prompt is deployed):**
that prompt is ~16.6k tokens, so telling the pacer the true size lifts it from
2 → 3 turns/min safely (3 × 16.6k = 49.8k < the 50k budget), cutting dev to
~4 min:

```bash
EVE_HOST=... EVAL_TOKENS_PER_REQUEST=16700 npm run eval:dev
```

Do **not** use that flag with the original ~20k-token prompt — it would
under-count and risk hitting the Azure limit.

## Important caveat

10 samples is for **direction**, not final numbers. A single sample flipping
is 10% here — treat the dev tier as "am I heading the right way?", and always
confirm a keep/kill decision with the full `npm run eval:run` (60 samples).

## What was added (all additive — nothing existing was changed)

- `evals/datasets/navio-kb-dev-subset-v1.json` — the 10-sample subset (verbatim copy from v2)
- `scripts/eval-dev.ts` — the wrapper (imports the unchanged `run-eval.ts`)
- `package.json` — one new line: `"eval:dev"`
- `scripts/run-eval.ts`, `lib/eval/*`, the agent, and the v2 dataset are **untouched**.
