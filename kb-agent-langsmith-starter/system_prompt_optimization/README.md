# System Prompt Optimization Workspace

**Status: analysis and candidates only. Nothing in this workspace has been
applied to the production system.** `agent/instructions.md` (the file eve
actually loads) has not been modified, no experiment configuration has been
changed, and no candidate below has been activated in any LangSmith run.
Every candidate is a plain text file sitting next to its own written
analysis, waiting for manual review.

## Purpose

This workspace is the output of an evidence-driven optimization pass over
the Navio Sportnavi agent's system prompt. The brief was: analyze the
already-completed 60-sample LangSmith experiment
(`agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728-de9dcfd1`)
plus the production prompt file itself, find real bottlenecks (not guesses),
and design prompt candidates that target those specific, measured problems —
without touching the running system.

Every claim in every report here traces back to either:
- a direct measurement of `agent/instructions.md`, or
- a specific sample/score from the completed LangSmith experiment, or
- a prior finding in `agent/feedback/FEEDBACK-ANALYSIS.md`.

The full, shared evidence base is in
[`analysis/TRACE_EVIDENCE.md`](analysis/TRACE_EVIDENCE.md) — every
per-version report below cites it rather than repeating the raw numbers.

## Current production baseline

| | |
|---|---|
| File | `agent/instructions.md` |
| Size | 85,598 characters (~21,400 tokens) |
| Composition | Knowledge Base = **89.3%** of the prompt; Identity 3.0%; Behavior Rules 4.3%; Conversational Intelligence 1.6%; Hard Limits 1.8% |
| Reference experiment | `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728-de9dcfd1` (60 examples, 64 turns) |
| Baseline quality scores | knowledge_retention 1.00 · must_not_include 1.00 · conciseness 1.00 · hallucination 0.967 · user_satisfaction 0.958 · tone 0.957 · answer_relevance 0.955 · perceived_error 0.949 · correctness 0.940 · language_match 0.917 |
| Baseline cost/perf | $0.70 agent cost total (~$0.0117/turn) · avg latency 3.91s (P50 3.60s / P99 8.44s) · TPM-bound at ~2 turns/min · zero 429s |

## Available candidate versions

| Version | Folder | Strategy | Token delta vs. baseline | Targets |
|---|---|---|---|---|
| **v1** | `versions/system_prompt_v1_kb_dedup/` | Remove duplicate KB document | **−3,906 tok (−18.2%)** | Cost, TPM throughput |
| **v2** | `versions/system_prompt_v2_kb_consolidated/` | v1 + fix one documented KB contradiction | −3,893 tok (v1's savings, ±1 line) | Hallucination, correctness |
| **v3** | `versions/system_prompt_v3_language_reinforcement/` | Append a language-mirroring reminder after the KB | +181 tok (+0.8%) | language_match, correctness (on refusal-type answers) |
| **v4** | `versions/system_prompt_v4_output_brevity/` | Recalibrate default answer length | +78 tok in the rule text itself (net effect is on *output*, not input, tokens) | Cost/turn (output pricing), latency (generation phase) |

(Folder names are more descriptive than a bare `v1`/`v2`/`v3`/`v4` to stay
easy to identify later, per the same naming-convention principle used for
the LangSmith experiment name itself. Each folder contains exactly two
files: `system_prompt.txt` — the full, standalone candidate prompt — and
`analysis_report.md` — the detailed reasoning.)

Each version is an **independent, standalone candidate** — every
`system_prompt.txt` is a complete, ready-to-use prompt (not a diff/patch),
built from a scripted, assertion-checked text transform of the original
file so there is zero transcription risk. v1 and v2 are content-reducing;
v3 and v4 are structural/instructional and barely change size. They are
designed to be independently testable, and v1+v2's changes don't overlap
with v3/v4's changes, so they can be combined later if desired (no combined
candidate was pre-built — each is meant to be validated on its own first).

## Summary of each proposed improvement

### v1 — Knowledge Base Deduplication
The prompt embeds two FAQ documents (`doc1.md`, `doc2.md`) that measure at
**73.4% word-level overlap**; `doc1.md` contributes zero headings/topics
that `doc2.md` doesn't already cover, and adds formatting noise (unescaped
`&amp;` entities). v1 removes `doc1.md` entirely. Expected: ~18% smaller
prompt, proportionally higher throughput at the same Azure TPM budget, no
expected quality change (doc2 is a strict content superset). Full report:
[`versions/system_prompt_v1_kb_dedup/analysis_report.md`](versions/system_prompt_v1_kb_dedup/analysis_report.md).

### v2 — KB Deduplication + Contradiction Fix
Builds on v1, plus fixes a specific, previously-documented KB
self-contradiction (pause-splitting eligibility) that was **independently
reproduced as a live failure** in the 60-sample benchmark
(`sample-028`: hallucination 0.00, correctness 0.00). Expected: same
token/cost profile as v1, plus a fix for this specific evidenced defect.
Full report:
[`versions/system_prompt_v2_kb_consolidated/analysis_report.md`](versions/system_prompt_v2_kb_consolidated/analysis_report.md).

### v3 — Language-Mirroring Reinforcement
All 4 genuine `language_match` misses in the benchmark shared one shape:
an English out-of-scope/jailbreak/injection/stress-test prompt answered in
German — never on a normal KB-lookup question. v3 appends a short reminder
block after the Knowledge Base (not before it, where the rule currently
lives) so the language-mirroring instruction is closer to the point of
generation. Expected: improved language_match/correctness on refusal-type
answers specifically, negligible token cost (+181 tokens). Full report:
[`versions/system_prompt_v3_language_reinforcement/analysis_report.md`](versions/system_prompt_v3_language_reinforcement/analysis_report.md).

### v4 — Output Brevity Default
Output tokens are billed at 16× the cached-input rate and directly drive
generation-phase latency (~82 tokens/second measured). The current rule is
a 400-word ceiling with no default target. v4 adds a ~100–150 word default
for simple questions while explicitly preserving the 400-word ceiling for
complex/multi-part questions and the example-driven answer style testers
praised. Expected: lower average output tokens on simple questions →
lower cost and latency on the majority of turns, no change to complex-answer
handling. Full report:
[`versions/system_prompt_v4_output_brevity/analysis_report.md`](versions/system_prompt_v4_output_brevity/analysis_report.md).

## How to test each version later

None of these should be copied into `agent/instructions.md` without manual
review first. Suggested validation path, from lowest to highest effort:

1. **Read the analysis report** for the candidate you're considering — each
   one ends with a "How to test this later" section with candidate-specific
   guidance (which samples to re-check, what to watch for).
2. **Manual spot-check.** Temporarily swap the candidate's `system_prompt.txt`
   into a local copy of `agent/instructions.md` (on a branch / backup —
   this repo is not currently under git, so make a manual copy of the
   original first), run `npm run typecheck && npm test`, start `npm run dev`,
   and try a handful of relevant questions.
3. **Rigorous comparison — full LangSmith re-run.** With the candidate
   swapped in locally:
   ```bash
   EVE_HOST=http://127.0.0.1:<port> \
   EVAL_EXPERIMENT_PREFIX="agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_<candidate-name>_v1_<date>" \
   EVAL_JUDGES="hallucination,correctness,answer_relevance,perceived_error,tone,user_satisfaction,knowledge_retention" \
   npm run eval:run
   ```
   Then compare the new experiment's aggregate scores and
   `input_tokens`/`output_tokens`/`cost_usd`/`latency_s` metrics side-by-side
   with the baseline experiment
   `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728-de9dcfd1`
   in the LangSmith compare view. This is the same rate-limit-aware,
   two-phase pipeline already used for the baseline — same cost model, same
   true-latency measurement, so the comparison is apples-to-apples.
4. **Revert instructions.md to the original** after testing if you were
   experimenting directly against the dev server, so production behavior is
   unaffected until you explicitly decide to adopt a candidate.

## What was NOT done (by design)

- No candidate combining all four fixes was pre-built, so each can be judged
  on its own evidence first.
- No candidate rewrites doc3/doc4/doc5 wholesale — only the two changes with
  clear, verified evidence (doc1 removal, the one-line contradiction fix)
  touch KB content at all; v3/v4 don't touch the KB.
- Nothing here was activated against the live agent, the dev server, or any
  LangSmith experiment. The existing baseline experiment and dataset are
  untouched.
