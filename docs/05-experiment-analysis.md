# 5. Experimentation and Evaluation Analysis

## In plain terms

We refuse to improve the chatbot by gut feel. Every prompt change is run against
the same set of questions and scored automatically, so we can say — with numbers —
whether it got better or worse on quality, cost, and speed. This document explains
how that measurement works and what it taught us.

## 5.1 The evaluation system

### The benchmark dataset
`navio-kb-testing-final-response-v2` — **60 questions** covering normal FAQs, edge
cases, multilingual (de/en/fr/es/ar), ambiguous phrasings, and a full **security
suite** (prompt injection, jailbreaks, system-prompt extraction, adversarial
input). Each example carries the input, a reference answer, expected behavior,
and deterministic "must include / must not include" anchors. A second, smaller
dataset — `navio-kb-dev-subset-v1` (**10 curated samples**) — powers the fast
iteration tier (below).

### The two-phase runner (`scripts/run-eval.ts`)
- **Phase A — execute:** a serial, rate-limit-paced loop calls the *real* agent
  for each question and records the answer, tokens, and **true latency**.
- **Phase B — evaluate:** replays those records into clean traces and runs the
  scorers.

**Why two phases?** So that rate-limit waiting never pollutes latency. Pacing
happens in Phase A *before* the latency clock starts; Phase B replays the measured
duration. The reported latency is therefore **true Azure model time**, not "time
spent waiting for our own throttle." Throttling/retry behavior is reported
*separately*.

## 5.2 Metrics

**Quality — 7 LLM-as-judge metrics** (structured output, temperature 0):
hallucination, correctness, answer_relevance, perceived_error, tone,
user_satisfaction, knowledge_retention. Plus **language quality** as a judge and
**language match** as a deterministic detector.

**Deterministic (free) checks:** must-include / must-not-include anchors,
conciseness (word-count limit).

**Cost & performance (per sample and aggregated):** input / output / cache-read
tokens, cache-aware cost, true model latency, and time-to-first-token.

## 5.3 How versions are compared in LangSmith

Each candidate runs as its **own experiment** against the **same** dataset and
evaluators, with a descriptive name (e.g. `cmp-v6-dev10-20260729`). LangSmith's
compare view then shows them side by side, per sample and in aggregate. The rule
for a valid A/B: **change exactly one variable — the prompt** — and keep dataset,
judges, model, and config identical.

## 5.4 The fast iteration tier (a key process win)

A full 60-question run takes ~35 minutes and consumes a lot of LangSmith trace
quota. That made iteration painful. So we built **`npm run eval:dev`**: the
10-sample curated subset with 2 core judges, ~6 minutes, ~$0.15. The 10 samples
are chosen to include the **regression guards** — the specific questions we know
are hard (the pause bug, language mirroring, a security refusal, a multi-turn
memory case). Workflow: iterate on `eval:dev`, confirm the winner on the full
`eval:run`.

## 5.5 Results — what the experiments showed

Representative 10-sample comparison (baseline vs the combined v5 vs the
re-architected v6):

| Metric | baseline | v5 | **v6** |
|---|---|---|---|
| hallucination | 70% | 90% | **93%** |
| correctness | 72% | 77% | **92%** |
| must-include anchors | 90% | 100% | 100% |
| language match | 90% | 80% | 80% |
| input tokens | ~199,900 | ~175,700 | **~167,600** |
| cost (10 samples) | $0.150 | $0.106 | ~$0.106 |

The original **full-60 baseline** scored: hallucination 0.97, correctness 0.94,
language 0.92, at ~$0.70 for 60 answers.

## 5.6 What worked, what failed, lessons learned

**What worked**
- Measurement turned prompt work into engineering. It repeatedly caught changes
  that *looked* right but did nothing.
- The dev-10 tier made iteration ~6× faster and preserved trace budget.
- Evidence-driven pruning produced a prompt (v6) that is *smaller and better*.

**What failed (and taught us)**
- **The "v2/v5 fixed the pause bug" assumption was false.** The evaluation proved
  the bug persisted on both — the fix was incomplete. We'd have shipped a
  non-fix without the benchmark. This is the single strongest argument for
  measuring.
- **Environment contamination.** Early runs silently used the *wrong* agent copy
  (a stale server on the same port); later, two agents sharing one Azure
  deployment caused latency spikes and made benign questions fail, contaminating a
  full run. *Lesson:* verify the served prompt (token count/hash) before trusting
  a run, and isolate the eval environment.
- **LangSmith trace quota is a budget.** A day of full-60 runs exhausted the
  monthly trace allowance and blocked a final confirmation. *Lesson:* iterate on
  the cheap tier; reserve full runs for sign-off.
- **Language mirroring is only partly promptable.** No version reliably fixed it
  at N=10; it has a stochastic component.

**How results influenced improvements.** Every v6 decision traces to data: keep
dedup (measured token win, no quality loss), drop the reminder block and verbose
brevity (no measured effect), fix the pause bug at the KB root (because the
surface patch measurably didn't work), add explicit ambiguity handling (because
that sample failed on every prior version).

## 5.7 Small-sample honesty

At 10 samples, one flipped example is 10%. We treat dev-10 as **directional** and
confirm keep/kill decisions on the full 60. We also separate *expected* security
blocks (which count as safety passes) from *genuine* failures so averages aren't
misread.
