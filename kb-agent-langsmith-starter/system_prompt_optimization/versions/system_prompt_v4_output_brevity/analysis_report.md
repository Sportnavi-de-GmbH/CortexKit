# v4 — Output Brevity Default (Latency & Cost via Completion Length)

**Strategy category:** Reducing unnecessary output verbosity
**Status:** Candidate only — NOT applied to `agent/instructions.md`. Not activated in any experiment.
**Full evidence base:** [`../../analysis/TRACE_EVIDENCE.md`](../../analysis/TRACE_EVIDENCE.md) §4

---

## In plain terms (non-technical summary)

Right now the agent is told to keep answers under 400 words, which is a
generous ceiling. Looking at the actual answers from the 60-question
benchmark, most simple questions got clear, correct, reasonably short
replies — but there's no *default target*, only a maximum. This candidate
adds a default target of about 100–150 words for straightforward questions,
while explicitly keeping the 400-word ceiling available for genuinely
complex, multi-part questions and explicitly protecting the example-driven
answer style that testers specifically praised in earlier feedback.

Why this matters for cost and speed: generating each word of a reply costs
16 times more than reading a word of the (cached) knowledge base, and it
also takes real time — the model has to generate the answer one piece at a
time, so a shorter answer finishes faster.

## What problem was identified from the traces

From the completed 60-sample benchmark (`TRACE_EVIDENCE.md` §4):

- Output length ranged from 28 to **534** tokens, averaging 188.4, with no
  enforced default — only the 400-word ceiling (~530 tokens).
- **Pricing asymmetry:** output tokens are billed at $8.00 per million,
  versus $0.50 per million for cached input tokens — a **16× per-token
  cost difference**. Even though output is a small fraction of total tokens
  (11,302 output vs 1,198,287 input across the whole run), it is
  disproportionately expensive per token.
- **Latency decomposition:** average total latency was 3.91s, of which
  TTFT (time-to-first-token) averaged 1.63s. The remaining ~2.3s is
  generation time for ~188 output tokens, implying roughly 82 tokens/second
  generation speed for this deployment. Generation time — and therefore
  total latency — scales with output length in a way that TTFT (dominated
  by the large cached prompt) does not.

## What bottleneck this targets

**Cost-per-token efficiency and generation-phase latency.** Unlike v1/v2
(which target the input side, ~89% of tokens but billed cheaply thanks to
caching), this candidate targets the output side: a smaller fraction of
total tokens, but the most expensive and the most directly latency-relevant
ones, because they can't be cached and must be generated sequentially.

## What was changed

Only the `ANTWORTLÄNGE` (answer-length) rule inside `HARD LIMITS` was
edited. The entire rest of the prompt — persona, KB, behavior rules,
conversational-intelligence guidance — is unchanged, verified by an
automated check.

Before → after (verbatim):

```diff
- • ANTWORTLÄNGE: Halte Antworten unter 400 Wörtern, außer der Nutzer bittet
-   ausdrücklich um eine ausführliche Erklärung.
+ • ANTWORTLÄNGE: Ziel sind ca. 100–150 Wörter für einfache Fragen (1 Fakt, 1
+   Beispiel, 1 nächster Schritt) — das reicht für die meisten Sportnavi-Fragen.
+   Nutze bis zu 400 Wörter NUR bei echt mehrteiligen/komplexen Fragen oder
+   wenn der Nutzer ausdrücklich um eine ausführliche Erklärung bittet. Kürzer
+   heißt NICHT: Beispiele weglassen — das konkrete Beispiel (z. B. mit Datum)
+   bleibt, wie in BEHAVIOR RULES Punkt 4 beschrieben.
```

Translated: instead of only a 400-word ceiling, the rule now states a
default target (~100–150 words, one fact + one example + one next step) for
simple questions, reserves the 400-word ceiling explicitly for genuinely
complex/multi-part questions or explicit user requests, and explicitly
protects the example-driven answer style (a direct pointer back to
Behavior Rule 4, which testers praised in `agent/feedback/FEEDBACK-ANALYSIS.md`:
"Beispiele in der Antwort finde ich sehr gut").

## Why this change may improve performance

A default target (not just a ceiling) gives the model a concrete anchor to
aim for on the majority of questions in this dataset, which are simple,
single-fact lookups (per the dataset's own `difficulty` distribution: 13
easy + 22 medium samples out of 60). The 400-word allowance is preserved
for the smaller set of genuinely complex/multi-step questions, so this is
not a blanket verbosity cut — it's a *default* recalibration.

## Expected impact

| Dimension | Expected effect | Basis |
|---|---|---|
| Output tokens (simple-question average) | Projected reduction from ~188 toward the ~100–150 target range on simple/FAQ-type questions specifically (not on complex/multi-part ones, which keep the higher ceiling) | Projection from the stated new target; **must be measured**, not assumed, since actual model compliance with a target varies |
| **Cost per turn** | Output tokens are 16× more expensive per token than cached input — even a modest output reduction has an outsized effect on the output-cost component specifically | `TRACE_EVIDENCE.md` §4 pricing figures |
| **Latency per turn** | Generation-phase time scales with output length (~82 tok/s measured); a shorter default should reduce total latency specifically via the generation phase, not TTFT | Direct arithmetic from measured generation rate |
| Answer quality / example-driven style | No expected change — the edit explicitly preserves the example-driven style rule and only recalibrates the *default*, not the ceiling | Explicit cross-reference to Behavior Rule 4 preserved in the new text |
| conciseness evaluator | Already scores 100% (60/60) against the 400-word ceiling in the baseline — this metric alone will not detect the improvement; a token-count/latency comparison is needed instead (see testing steps) | `TRACE_EVIDENCE.md` §4 and the full-60 experiment report |

## Risks / trade-offs

- **Under-explaining risk:** a lower default could cause the agent to trim
  necessary context on borderline-complex questions that don't clearly
  signal their complexity up front. The instruction mitigates this by
  explicitly carving out "echt mehrteilige/komplexe Fragen" (genuinely
  multi-part/complex questions) as exempt, but where that line falls is a
  judgment call the model still has to make — this should be watched in
  testing, specifically on the dataset's `medium`/`hard`/`expert` difficulty
  samples.
- **Existing `conciseness` evaluator won't detect a regression or an
  improvement**, since it only checks a 400-word ceiling that both the
  original and this candidate satisfy. A raw token-count comparison (not
  a pass/fail evaluator) is needed to actually measure the effect — see
  below.
- **Smallest-scope candidate in this set** — it targets a specific,
  narrow lever (default length) and does not address KB duplication,
  the KB contradiction, or language mirroring. It is meant to be
  combinable with v1/v2/v3, not a replacement for them.

## How to test this later

1. Manually try 5–10 simple FAQ questions (e.g. the `easy`/`beginner`
   difficulty samples in the dataset) against this candidate and compare
   output word counts to the baseline experiment's per-sample numbers
   (available in the LangSmith experiment
   `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728`).
2. Manually try 2–3 genuinely complex/multi-part questions (e.g.
   `sample-008`, `sample-009` — tariff comparisons requiring multi-part
   reasoning) and confirm the answer is NOT truncated or under-explained.
3. For a rigorous comparison, run the full 60-sample LangSmith evaluation
   against this candidate and compare `output_tokens` and `latency_s`
   metrics directly (not just the pass/fail evaluators) against the
   baseline experiment — the improvement this candidate targets shows up
   in the raw metric values, not in a pass/fail score.
