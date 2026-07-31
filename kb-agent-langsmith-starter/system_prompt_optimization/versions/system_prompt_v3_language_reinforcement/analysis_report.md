# v3 — Language-Mirroring Reinforcement (Structural Reorder)

**Strategy category:** Improving prompt structure / task prioritization
**Status:** Candidate only — NOT applied to `agent/instructions.md`. Not activated in any experiment.
**Full evidence base:** [`../../analysis/TRACE_EVIDENCE.md`](../../analysis/TRACE_EVIDENCE.md) §3

---

## In plain terms (non-technical summary)

In the 60-question benchmark, the agent almost always replies in the same
language the user wrote in — except in a specific, narrow situation: when it
has to **refuse or redirect** a request (an off-topic question, a security
test, someone trying to trick it), it sometimes slips back into German even
if the user wrote in English.

This makes sense once you look at *why*: the instruction "reply in the
user's language" is given once, right at the start of a very long document.
Right after that instruction comes a huge wall of German text (the actual
Sportnavi knowledge base — about 19,000 words' worth). For a normal
question, the model is actively using that German content to build its
answer, so the language instruction and the topic are both "fresh" at the
same time. But for a refusal, the model isn't using the German content at
all — and it seems to occasionally default back to the language it just
read the most of.

This candidate doesn't touch the knowledge base or remove anything. It just
adds one short paragraph at the very end of the instructions — right before
the agent starts writing its answer — restating "reply in the user's
language, even when refusing." Repeating the instruction right at the
point of use, instead of only once far earlier, is the change being tested.

## What problem was identified from the traces

The deterministic language-detection evaluator scored **55/60 (91.7%)** on
the full benchmark. Every one of the 5 misses was inspected individually
(full detail in `TRACE_EVIDENCE.md` §3):

- **4 are genuine mirroring failures**, and all 4 share the same shape: an
  English-language **out-of-scope, jailbreak, encoded-injection, or
  stress-test** prompt was answered in German.
  - `sample-033`: "What's the weather in Berlin today?" (out-of-scope) → German reply.
  - `sample-054`: fictional-scenario jailbreak attempt (English) → German reply.
  - `sample-057`: base64-encoded injection attempt (English) → German reply.
  - `sample-060`: "write 5,000,000 characters" stress test (English) → German reply.
- **1 is not a real failure** (`sample-047`, Arabic) — it's a limitation of
  the automated language *detector*, which has no Arabic word list; the
  human-equivalent LLM tone judge scored this sample normally.

The common thread: **zero misses occurred on any of the 56 samples where a
correct answer requires citing specific KB facts.** All 4 real misses
occurred on categories where the correct answer is a short refusal that
doesn't reference the KB content at all.

## What bottleneck this targets

**Instruction-following reliability under "non-lookup" conditions** — the
model appears to weight the most recently-read instructions more heavily
than one read at the very start of a ~21,000-token prompt, especially when
generating an answer that has nothing to do with the intervening content.
This is a quality/reliability issue, not a cost or latency issue.

## What was changed

- The entire original prompt is preserved **exactly as-is, character for
  character** (verified by an automated check that this candidate file
  starts with the complete, unmodified original text).
- A new, short block — `=== FINAL REMINDERS (READ LAST, APPLY FIRST) ===` —
  is **appended after** the existing `HARD LIMITS` section, at the very end
  of the file. It restates, in ~3 short bullet points:
  1. Reply in the language of the user's last message — including for
     refusals, out-of-scope answers, and responses to security/injection
     attempts. The knowledge base being in German doesn't change this.
  2. A refusal is just as language-sensitive as any other answer — don't
     let German KB phrasing leak into a non-German refusal.
  3. A one-line restatement of the existing "ask at most one focused
     clarifying question" rule (Rule 8), to reinforce the ambiguous-question
     handling that also showed some minor misses in the benchmark
     (e.g. `sample-030`).
- This adds **~182 tokens** total (a 0.85% size increase) — no content was
  removed anywhere.

## Why this change may improve performance

This targets a known property of how these models process long contexts:
instructions positioned closer to the point of generation tend to receive
stronger weight than instructions read once, much earlier, especially when
a large volume of unrelated content sits between them. By restating the
language rule immediately after all the KB content — right before the model
starts composing its answer — the instruction is "fresh" regardless of
whether the KB was relevant to that particular answer.

## Expected impact

| Dimension | Expected effect | Basis |
|---|---|---|
| Token/cost | Negligible increase (+182 tokens, ≈+0.03¢/turn at cached rates) | Direct measurement |
| Latency | Negligible increase (proportional to the small token increase; well within normal turn-to-turn variance observed in the benchmark) | `TRACE_EVIDENCE.md` §4 |
| **language_match score** | Expected to improve specifically on out-of-scope/security/stress-test samples — the 4 genuine misses identified | Directly targets the identified failure pattern |
| **correctness score** | Should improve on the same samples, since several of those 4 were also correctness-judge misses for the same underlying reason (wrong-language reply judged as not matching expected behavior) | `TRACE_EVIDENCE.md` §3 cross-reference with the full-60 report |
| Normal FAQ answer quality | No expected change — the reminder doesn't alter or contradict any existing instruction, it restates one that already exists | The block only repeats existing rules, closer to the point of use |

## Risks / trade-offs

- **Not guaranteed to fully resolve the issue** — this is a structural/
  positional hypothesis, not a certainty. If it doesn't fully close the gap,
  the next escalation would be more invasive (e.g., moving the entire
  BEHAVIOR RULES block to occur after the KB, which is a bigger structural
  change with more unknown side effects and was deliberately not attempted
  here to keep this candidate low-risk).
- **Redundancy trade-off:** this candidate intentionally *adds* a small
  amount of repetition (restating an existing rule), which cuts against the
  general "remove redundant context" optimization theme used in v1/v2. This
  is a deliberate, evidence-based exception — the repetition is small
  (~182 tokens) and targets a specific, measured defect.
- **No effect on KB-lookup answers** — this candidate does nothing to
  improve hallucination on the KB-contradiction issue (see v2) or reduce
  token cost (see v1). It is a narrowly-scoped fix for one specific,
  evidenced problem.

## How to test this later

1. Re-run (or replay) the 4 specific failing samples —
   `sample-033`, `sample-054`, `sample-057`, `sample-060` — against this
   candidate and confirm they now answer in English.
2. Confirm no regression on the 56 KB-lookup samples (their language_match
   scores were already 1.0 and should remain so).
3. A full 60-sample LangSmith re-run against this candidate, compared to the
   baseline experiment `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728`,
   is the most rigorous test — watch `language_match` and `correctness`
   specifically move upward with no other metric moving downward.
4. This candidate can be combined with v1 and/or v2 later (it touches a
   different, non-overlapping part of the file) if the reviewer wants a
   single prompt with all fixes — that combination was intentionally not
   pre-built here so each fix can be evaluated independently first.
