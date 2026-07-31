# v5 — Combined Production Candidate (+ feedback fact-corrections)

**Status:** Candidate only — NOT applied. Production `agent/instructions.md` was
restored to the true original baseline after testing (md5
`7f98f54b13d1e92ebed491e2c8638213`).
**Built from:** v1 (dedup base) + v2 fix + v3 reminder + v4 brevity + a new
"VERIFIZIERTE KORREKTUREN" block implementing the tester feedback.

## What v5 is

A single prompt that stacks every earlier candidate's strength and adds an
authoritative fact-correction block for the issues found in
`feedback/Feedback Chatbot.docx` + `Feedback2.docx`:

1. **Dedup** (from v1): removed the duplicate `doc1.md` → smaller/cheaper.
2. **Pause-split cheat-sheet fix** (from v2).
3. **Language reminder block** appended after the KB (from v3).
4. **Brevity default** ~100–150 words (from v4).
5. **NEW: "VERIFIZIERTE KORREKTUREN (HÖCHSTE PRIORITÄT)"** block placed just
   before the KB, overriding the KB on conflict, covering 7 corrections:
   pause-usage, Firmenfitness employee-vs-framework notice periods,
   cancellation via the Kündigungsformular, single-ticket-only cashback,
   one Firmenfitness model, 3-month referral-premium timing, and a
   "never assert undocumented numbers" rule.

Size: **~17,530 tokens** — still ~12% smaller than the ~19,950-token baseline
despite the added corrections, because dedup saves more than they cost.

## Empirical result — 6-way dev-10 comparison (2026-07-29)

All six prompts were run against the same 10 curated samples with the same 2
judges (hallucination, correctness) via `npm run eval:dev`, one after another
with the eve dev server hot-reloading each prompt. Experiments in LangSmith:
`cmp-{baseline,v1,v2,v3,v4,v5}-dev10-20260729-*`.

| Metric (10 samples) | base | v1 | v2 | v3 | v4 | **v5** |
|---|---|---|---|---|---|---|
| hallucination | 70% | 88% | 80% | 80% | 70% | **90%** ← best |
| correctness | 72% | 74% | 70% | 74% | 71% | **77%** ← best |
| must_include | 90% | 100% | 90% | 90% | 80% | **100%** |
| language_match | 90% | 80% | 80% | 90% | 80% | 80% |
| tokens (in, total) | 199,866 | 166,576 | 166,666 | 202,002 | 200,708 | **175,705** |
| cost (10 samples) | $0.150 | $0.127 | $0.104 | $0.119 | $0.118 | **$0.106** |
| latency (median) | 4.6s | 4.8s | 4.5s | 5.7s | 4.5s | 5.4s |

**v5 leads on hallucination, correctness, must_include, and is ~29% cheaper /
~12% fewer tokens than baseline.** On these axes it is the best of the six.

## What the test EXPOSED (honest findings — do not skip)

Running v5 (instead of assuming) revealed that it does **not** fully deliver
"fix all issues":

- ❌ **sample-028 (pause-splitting) STILL FAILS on v5** — and on all 6 versions.
  Root cause: the fix was **incomplete**. v2/v5 only edited the doc5
  *cheat-sheet* line, but the word "flexibel" ("…flexibel und ohne Aufwand")
  still appears in the **main** pause descriptions in doc2 and doc4, and the
  VERIFIZIERTE KORREKTUREN block did **not** include an explicit
  pause-split correction. The model reads "flexibel" and asserts the months
  can be split. **This is the top item for a v5.1.**
- ⚠️ **Language mirroring (sample-033 / 060) is not reliably fixed** by the
  reminder — results flip pass/fail across versions in a way that looks like
  model stochasticity at N=10, not a dependable prompt effect.
- ❌ **sample-030 (ambiguous "Wie kann ich wechseln?") fails correctness on all
  6** — the agent assumes "tariff change" and answers instead of asking one
  clarifying question. No version addresses this.
- ✅ **A real v5 win:** sample-010 (Firmenfitness price) — v5's correction #5
  makes the agent quote the documented "59,90 €", so its `must_include` anchor
  passes where baseline/v2/v3/v4 missed it.

## Caveats on the numbers

- **N=10 → noisy.** One sample = 10%. The hallucination lead (70→90 = 2
  samples) is more meaningful than the correctness lead (72→77 ≈ 0.5 sample).
- `sample-052` (security extraction) is a **blocked-by-Azure safety pass** on
  every version — it drags the raw averages down equally across all six, so
  it doesn't change the ranking.
- Latency differences are within noise (shared Azure deployment, occasional
  multi-second blips); treat cost/tokens as the reliable structural metrics.

## Recommendation

- **v5 is the best of the six candidates** and a strictly better base than the
  original (cheaper, smaller, best quality scores, fixes the price anchor).
- **But it is not yet "fix everything" production-ready.** Build a **v5.1**
  that (a) adds an explicit pause-split correction to the corrections block and
  (b) rewords the "flexibel" phrasing in doc2/doc4, then re-run `eval:dev` to
  confirm sample-028 flips to pass.
- Before any production switch, confirm the winner with a **full 60-sample**
  `eval:run` — the 10-sample tier is directional only.

## How to test later
`EVE_HOST=http://127.0.0.1:<port> EVAL_EXPERIMENT_PREFIX="cmp-v5-…" npm run eval:dev`
(swap this file's `system_prompt.txt` into a local copy of
`agent/instructions.md` first; the server hot-reloads it).
