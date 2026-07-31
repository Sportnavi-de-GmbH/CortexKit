# v2 — KB Deduplication + Documented Contradiction Fix

**Strategy category:** Removing redundant context + reconciling inconsistent facts
**Status:** Candidate only — NOT applied to `agent/instructions.md`. Not activated in any experiment.
**Builds on:** v1 (includes the same doc1.md removal)
**Full evidence base:** [`../../analysis/TRACE_EVIDENCE.md`](../../analysis/TRACE_EVIDENCE.md) §1–2

---

## In plain terms (non-technical summary)

This candidate does everything v1 does (removes the duplicate FAQ document),
**plus** it fixes one specific, already-documented mistake in the knowledge
base: two different sections disagree about whether members can split their
"pause" months into separate blocks or must ask support first. One section
correctly says "this isn't clearly documented — ask support"; another
section, a quick-reference cheat-sheet, incorrectly states it as a settled
fact ("flexibel aufteilbar" / "can be split flexibly").

This isn't a hypothetical concern — **it actually happened** in the
60-sample benchmark we already ran. A test question about pausing
membership got the wrong, overconfident answer, and the evaluation system
caught it and scored it 0/1 on both hallucination and correctness. This
candidate fixes exactly that.

## What problem was identified from the traces

1. Everything in v1 applies (doc1.md is a 73.4%-overlapping duplicate — see
   `TRACE_EVIDENCE.md` §1).
2. **A specific, previously-documented KB contradiction was reproduced live
   during the 60-sample experiment.** `agent/feedback/FEEDBACK-ANALYSIS.md`
   (Issue 8, written by a human tester before this workspace existed) had
   already flagged that the KB's detailed section says the
   split-vs-consecutive pause question is undocumented, while a separate
   "cheat sheet" summary elsewhere asserts it's flexible. In the completed
   experiment, sample `sample-028` triggered exactly this: the agent
   confidently repeated the cheat-sheet's wrong claim, and scored
   **hallucination = 0.00, correctness = 0.00, answer_relevance = 0.30** —
   full detail in `TRACE_EVIDENCE.md` §2.

## What bottleneck this targets

**Quality and reliability — specifically, self-contradiction risk baked
into the prompt itself.** No prompt engineering can prevent a model from
occasionally repeating a wrong fact if the prompt itself contains two
different, disagreeing statements of that fact. This is a correctness
defect at the source (the KB text), not a persona/instruction-following
defect.

## What was changed

Starting from v1 (doc1.md already removed):

- One line in doc5's "wichtigste Regeln" (most important rules) summary was
  changed from asserting the pause months "can be split flexibly" to
  matching doc4's honest framing: the split-vs-consecutive detail isn't
  confirmed and should be checked with support.
- **Nothing else was changed.** This is a single, targeted, one-line edit
  layered on top of v1's document removal — verified by an automated check
  that the phrase "flexibel aufteilbar" no longer appears anywhere in the
  file after the edit.

Before → after (verbatim):

```diff
- 6. **Pause nur 4/5-Sterne** – 3 Monate pro Kalenderjahr, flexibel aufteilbar
+ 6. **Pause nur 4/5-Sterne** – 3 Monate pro Kalenderjahr (Aufteilung einzeln/am Stück: bitte beim Support erfragen, siehe unten)
```

## Why this change may improve performance

The model cannot be instructed its way out of a genuine factual
contradiction in its own reference material — it will sometimes pick
whichever version it attends to more strongly, effectively at random from
the product owner's perspective. Removing the contradiction (by aligning
both statements to the more conservative, honest one) removes the failure
mode entirely, rather than trying to suppress it with additional rules.

This candidate deliberately chose the **conservative fix** (both places now
say "ask support") rather than asserting an unconfirmed guess about the real
policy. `FEEDBACK-ANALYSIS.md`'s own recommendation was to confirm the real
rule with the business owner — until that happens, "ask support" is the
factually safe answer in both places.

## Expected impact

| Dimension | Expected effect | Basis |
|---|---|---|
| Token/cost/throughput | Same as v1 (this is v1 + a 1-line edit; net token change is negligible, well under 20 tokens) | Direct diff |
| **Hallucination score on this specific scenario** | Should move from a confirmed 0.00 failure toward a pass, since the agent no longer has a confident-but-wrong claim to repeat | Direct causal fix of the observed failure mode |
| **Correctness score on this specific scenario** | Same — should move from 0.00 toward a pass (a consistent "ask support" answer is scored as correct per the dataset's `expected_behavior` field for this and similar boundary-case samples) | Dataset schema; see `evals/datasets/navio-kb-testing-final-response-v2.json` sample-028/029 |
| Other quality metrics | No expected change | The edit is scoped to one factual claim |
| User experience | Slightly less "confident-sounding" on this one topic (an honest "ask support" instead of a firm answer) — a deliberate, evidence-based trade-off until the real policy is confirmed | — |

## Risks / trade-offs

- **This is a genuine content change, not just a structural one** — unlike
  v1, v3, and v4, this candidate edits what the agent will actually tell a
  user about a real policy. If the real Sportnavi policy actually IS
  "flexible splitting is allowed," this fix makes the agent *more* cautious
  than necessary (routing users to support for something that might already
  be self-service). **This should be confirmed with the business owner**,
  exactly as `FEEDBACK-ANALYSIS.md` originally recommended — this candidate
  does not resolve the underlying ambiguity, it only makes the agent stop
  contradicting itself about it.
- All of v1's risks also apply here, since v2 builds on v1's document
  removal.

## How to test this later

1. Confirm the real "can pause months be split?" policy with the Sportnavi
   business owner first — if the answer turns out to be a firm yes or no,
   update both doc4 and doc5 to state that firm answer consistently instead
   of routing to support.
2. Re-run (or replay) the specific failing example from the benchmark —
   `sample-028` in `evals/datasets/navio-kb-testing-final-response-v2.json`
   — against this candidate prompt and confirm hallucination/correctness
   scores move away from 0.00.
3. As with v1, a full 60-sample LangSmith re-run against this candidate
   (compared to the baseline experiment
   `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728`)
   is the most rigorous validation — watch specifically for `sample-028`'s
   scores and confirm nothing else regresses.
