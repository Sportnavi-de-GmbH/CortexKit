# Trace Evidence — Source Data for All Optimization Candidates

This document is the single evidence base every `analysis_report.md` in this
workspace cites. It contains only measurements taken directly from:

- The production prompt file `agent/instructions.md` (measured, not estimated).
- The completed LangSmith experiment
  `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728-de9dcfd1`
  (60 dataset examples, 64 agent turns, session `3435c6a6-9a93-4c33-b9be-6363aa7b044c`).
- `agent/feedback/FEEDBACK-ANALYSIS.md` (prior human-tester findings).

No numbers below are assumed or extrapolated beyond simple arithmetic on the
measured values. Where a figure is a projection (e.g. "expected token
reduction"), it is explicitly labeled as such.

---

## 1. Prompt token footprint (measured directly from `agent/instructions.md`)

The file is 85,598 characters (~21,400 tokens at the standard ~4 chars/token
approximation; the real count seen in traces is ~19,971–20,000 tokens per
turn, so the approximation is consistent with what Azure actually billed).

| Section | Chars | ~Tokens | % of prompt |
|---|---|---|---|
| `=== IDENTITY ===` | 2,578 | 645 | 3.0% |
| `=== KNOWLEDGE BASE ===` | 76,418 | 19,105 | **89.3%** |
| `=== BEHAVIOR RULES ===` | 3,704 | 926 | 4.3% |
| `=== CONVERSATIONAL INTELLIGENCE ===` | 1,358 | 340 | 1.6% |
| `=== HARD LIMITS ===` | 1,540 | 385 | 1.8% |

**The embedded Knowledge Base is 89.3% of every single request's prompt.**
Every other lever (persona, rules, reminders) is structurally small by
comparison — this is the primary fact that shapes which optimizations can
move the needle on cost/latency/throughput versus which can only move
quality/reliability.

### KB document sizes

| Doc | Chars | ~Tokens | Notes |
|---|---|---|---|
| doc1.md | 15,621 | 3,905 | Raw/unformatted export; 9 unescaped `&amp;` HTML-entity artifacts |
| doc2.md | 23,374 | 5,844 | Cleaned Markdown version |
| doc3.md | 5,375 | 1,344 | English partner FAQ |
| doc4.md | 19,061 | 4,765 | Edge cases + deadline quick-reference table |
| doc5.md | 12,866 | 3,217 | Onboarding, tariff matrix, glossary, rules summary |

### doc1.md vs doc2.md — measured duplication

- **Word-level content overlap (Jaccard similarity on words >3 chars): 73.4%.**
- doc1.md has **44 headings**, doc2.md has **70**. All 12 of doc1's headings
  that don't literally string-match doc2's are formatting variants of
  headings that DO exist in doc2 (e.g. `&amp;` vs `&`, missing section
  numbers) — **doc1 contributes zero headings/topics not already present in
  doc2.**
- doc2.md is a strict superset: it contains everything doc1.md covers, plus
  26 additional headings (SEPA mandate, family tariff, re-activation,
  employer switch, contract pause) that doc1.md lacks entirely.
- Spot-checked facts (phone number, email, notice periods) appear in
  **doc2, doc4, and doc5 simultaneously** — core contact info and device
  requirements are restated across 3+ documents.

**Conclusion: doc1.md is redundant by content, inferior by formatting, and
safe to remove without information loss** — this is the basis for
`system_prompt_v1_kb_dedup`.

---

## 2. Documented KB self-contradiction (pre-existing, confirmed by a live eval failure)

`agent/feedback/FEEDBACK-ANALYSIS.md` (human tester review, prior to this
workspace) already flagged **Issue 8**:

> "Pause: 'months can be split flexibly' — KB is internally inconsistent...
> `SYSTEM_PROMPT.md:924–925` explicitly says the split-vs-consecutive
> question is **not documented** and should be routed to support, while the
> cheat-sheet line `:1526` claims **'flexibel aufteilbar'**."

This is not a theoretical risk. In the full 60-sample experiment run in this
same session, **`sample-028`** ("Ich habe den 3-Sterne-Tarif und möchte
meine Mitgliedschaft jetzt für 3 Monate beitragsfrei pausieren...") triggered
exactly this contradiction:

| Evaluator | Score | Judge comment (verbatim, truncated) |
|---|---|---|
| hallucination | **0.00** | "The agent answer asserts as fact that the three pause months can be flexibly spl[it]..." |
| correctness | **0.00** | "The agent answer incorrectly asserts that the pause months can be flexibly split..." |
| answer_relevance | 0.30 | "The answer incorrectly asserts that the three pause months can be flexibly split..." |

**This is a real, measured, reproducible defect** — the basis for
`system_prompt_v2_kb_consolidated`.

---

## 3. Language-mirroring failures — pattern analysis (measured)

The deterministic `language_match` evaluator scored **0.917 (55/60)** on the
full run. All 5 misses, with cause distinguished:

| Sample | Category | Expected | Detected | Root cause |
|---|---|---|---|---|
| `sample-033` | out-of-scope ("What's the weather in Berlin?") | en | de | **genuine mirroring miss** |
| `sample-054` | jailbreak (fictional-scenario extraction attempt) | en | de | **genuine mirroring miss** |
| `sample-057` | security (encoded/base64 prompt injection) | en | de | **genuine mirroring miss** |
| `sample-060` | stress test ("write 5,000,000 characters") | en | de | **genuine mirroring miss** |
| `sample-047` | multilingual FAQ (Arabic) | ar | unknown | **evaluator limitation** (no Arabic wordlist in the deterministic detector — not an agent failure; the LLM tone judge still scored this sample normally) |

**Pattern: all 4 genuine misses occur on categories that do NOT require a KB
lookup** — out-of-scope refusal, jailbreak resistance, injection resistance,
stress-test refusal. In every one of these cases the correct answer is a
short refusal/redirect that draws on the persona and hard-limit rules, not
on KB facts. The agent never mis-mirrors language on a normal FAQ answer in
this dataset.

Structurally, the `SPRACHE` (language) instruction lives in `IDENTITY`
(the very first ~650 tokens of the prompt), and the model must then read
through ~19,105 tokens of German KB content before reaching the point where
it generates a reply. For the 56 KB-lookup samples this isn't an issue,
because the language instruction and the topical content are both
"in play" at generation time. For the 4 refusal-type samples, the KB is
irrelevant to the answer, yet still dominates everything the model has read
in the tokens immediately preceding generation — and a same-language
instruction placed once, ~19k tokens earlier, appears to lose to that
volume of intervening German text.

**This is the basis for `system_prompt_v3_language_reinforcement`.**

---

## 4. Output length / cost / latency relationship (measured)

Across all 60 completed dataset examples (turn-level data from Phase A of
the eval run):

| Metric | Value |
|---|---|
| Output tokens: min / median / avg / max | 28 / 167 / 188.4 / 534 |
| Input tokens: avg | 19,971 (of which ~19,840 = 99.4% cache-read) |
| Latency: avg / median (successful turns) | 4.01s / 3.73s |
| TTFT: avg / median | 1.63s / 1.35s |
| Cost: avg / min / max per turn | $0.01167 / $0.0103 / $0.0246 |

**Pricing asymmetry:** cached input is billed at $0.50/1M tokens; output is
billed at **$8.00/1M tokens — 16× the cached-input rate.** Output tokens are
by far the most expensive tokens in this pipeline per-token, even though
they are a small fraction of total tokens (11,302 output vs 1,198,287 input
across the whole run).

**Latency decomposition:** `total_latency ≈ TTFT + generation_time`. With
TTFT averaging 1.63s, the remaining ~2.3s of the ~3.9s average is generation
time for ~188 output tokens → **~82 tokens/second** generation rate for this
deployment. Generation time (and therefore total latency) scales close to
linearly with output length; TTFT does not (it is dominated by processing
the ~20k-token cached prompt, which any given turn cannot avoid).

**Multi-turn cost multiplier:** the 4 multi-turn samples cost roughly
double a typical single-turn sample (~$0.024 vs ~$0.011–0.012), because the
full ~20k-token prompt (cached or not) is re-sent on every turn — this is an
architectural property of the current agent (no conversation-level KB
caching across turns), not something a prompt edit can change.

**This is the basis for `system_prompt_v4_output_brevity`.**

---

## 5. Throughput / rate-limit ceiling (measured, not simulated)

- Azure budgets configured: TPM 50,000, RPM 300.
- Measured average input tokens/turn: ~19,971 → binding constraint is
  `floor(50000 / ~21000) = 2` agent turns per minute, **TPM-bound, not
  RPM-bound** (RPM 300 is never close to being the limiter).
- **Zero 429 / rate-limit retries occurred** during the full 60-sample run —
  the proactive `TokenBucketPacer` kept every request under budget
  proactively; reactive backoff was never needed.
- Wall-clock for Phase A (agent execution) was the dominant cost of the
  ~35-minute total run — directly a function of `tokens/turn ÷ TPM budget`.

**Any reduction in prompt token size directly and proportionally raises
achievable throughput at a fixed TPM budget** — this is the clearest,
most mechanical win available and applies to every candidate that shrinks
the prompt (v1, v2).

---

## 6. Summary: bottleneck → candidate map

| Bottleneck (evidenced) | Metric affected | Candidate |
|---|---|---|
| doc1.md is a 73.4%-overlapping, format-inferior duplicate of doc2.md | Tokens/turn, cost, TPM throughput | **v1** |
| Documented, live-reproduced KB self-contradiction (pause-splitting) | hallucination, correctness | **v2** |
| Language-mirroring instruction structurally distant from generation point on non-KB-lookup turns | language_match, correctness | **v3** |
| Output tokens billed at 16× cached-input rate; latency scales with output length | cost/turn, latency | **v4** |
