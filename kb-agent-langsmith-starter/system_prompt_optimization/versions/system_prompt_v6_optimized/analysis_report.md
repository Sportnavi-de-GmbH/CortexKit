# v6 — Optimized, Re-architected Production Candidate

**Status:** Candidate only — NOT applied. Production `agent/instructions.md`
stays on the true original baseline (md5 `7f98f54b13d1e92ebed491e2c8638213`).
**Size:** ~16,730 input tokens (measured live) — the **leanest** of all
candidates: smaller than baseline (~19,950, **−16%**) *and* smaller than v5
(~17,530, **−5%**).

v6 is not "v5 with a patch." It is a ground-up reorganization of the
instruction wrapper into a clean 9-section structure, driven by the evidence
from the 6-way dev-10 comparison (`cmp-{baseline,v1..v5}-dev10-20260729`).

## Critical analysis that shaped v6 (evidence, not vibes)

| Observation from the 6-way run | Decision in v6 |
|---|---|
| **Dedup (v1)** cut ~17% tokens with no quality loss; v1 tied/led quality. | **Kept** — dedup KB is the base. |
| **v5's correction block** measurably changed behavior: it made `sample-010` quote "59,90 €" (must_include passed on v1/v5, failed on base/v2/v3/v4). | **Kept & strengthened** the corrections block. |
| **v2's one-line pause fix had NO effect** — `sample-028` still failed on v2 *and* v5. Root cause: "flexibel" survived in the *main* KB text (doc2/doc4), and there was no explicit pause-split correction. | **Fixed properly** — see below. |
| **v3's language reminder had no reliable effect** (language_match: base 90%, v3 90%, v5 80% — noise). It also added a separate appended block = redundant tokens. | **Removed the separate block**; folded a single strong language rule into Section 7 (post-KB, for recency). |
| **v4's brevity rewrite didn't move any score** (conciseness was already 100% everywhere — the 400-word ceiling never bound). | **Kept only a lean 1-line default**, dropped the verbose version. |
| **`sample-030` (ambiguous "wechseln") failed correctness on ALL 6** — no version addressed it. | **New Section 8** with explicit disambiguation guidance. |
| The old prompt had **overlapping/scattered** rules (BEHAVIOR RULES + CONVERSATIONAL INTELLIGENCE + HARD LIMITS repeating tone/format/language). | **Consolidated** into 9 non-overlapping sections. |

## What was taken from each version

- **v1 → deduplicated KB** (doc1 removed): the token/cost base.
- **v2 → the intent** of reconciling the pause contradiction (but implemented
  correctly this time).
- **v3 → one** strong language-mirroring rule (not the redundant appended block).
- **v4 → a lean** ~100–150-word default (Section 9), keeping the example-driven
  style testers praised.
- **v5 → the verified-corrections approach** and "never invent undocumented
  facts" rule — the single most behavior-changing idea, kept and extended.

## What was removed and why

- The separate `=== FINAL REMINDERS ===` appended block (v3/v5): redundant with
  the structured sections → removed to save tokens and avoid duplication.
- v4's multi-line brevity paragraph: no measurable benefit → trimmed to 1 line.
- Scattered repetition of tone/format/language across three legacy sections →
  merged, cutting v6 below even v5 in size.

## New improvements added

1. **Pause-splitting fixed at the root (the v5 miss):**
   - KB edits: removed "– flexibel und ohne Aufwand" from doc2 & doc4, and
     reworded the doc5 cheat-sheet line — so the KB no longer *implies*
     splittability anywhere.
   - Explicit **Correction #2 (PAUSE-AUFTEILUNG)**: "not documented; NEVER claim
     they are 'flexibel aufteilbar'; route to support."
   - Belt-and-suspenders: the wrong fact is gone from the KB *and* an
     authoritative override forbids it.
2. **Pause-usage fact corrected (feedback issue 1):** the two KB statements that
   wrongly said the membership is "nicht nutzbar" during a pause were rewritten
   to the correct rule (you *can* check in, but it lifts the pause + charges the
   fee) — matching Correction #1.
3. **Ambiguity handling (Section 8):** concrete trigger words ("wechseln",
   "Preise?", …) + a mandated single clarifying question with the likely options,
   explicitly forbidding the "assume Tarifwechsel" behavior that failed
   `sample-030`.
4. **Language rule hardened & repositioned** (Section 7, right after the KB) with
   the refusal-case emphasis and explicit multi-language coverage.
5. **Clean 9-section structure** (role → core rules → quality → fact accuracy →
   corrections → KB usage → language → ambiguity → efficiency → security).

## Why v6 should perform better

- It is the only version that fixes `sample-028` at *both* the KB and override
  level — the earlier failure was purely because the KB still contained the
  contradicting word.
- It keeps every empirically-positive element (dedup, corrections, price anchor)
  and drops every element that showed no measurable effect (redundant reminder
  block, verbose brevity) → same or better quality at lower token cost.
- It directly targets the two unaddressed failures (`028`, `030`).

## Expected impact

| Dimension | Expectation | Confidence |
|---|---|---|
| Hallucination | ≥ v5 (should now also pass `sample-028`) | Medium-high (direct fix) |
| Correctness | ≥ v5; `sample-028` + possibly `sample-030` improve | Medium |
| Relevance | ≈ v5 / slightly up (better ambiguity handling) | Medium |
| Language | ≈ v5 (mirroring is partly model-stochastic; not guaranteed) | Low-medium |
| Cost / tokens | **Best of all candidates** (~16.7k tok, −16% vs baseline) | High (measured) |
| Latency | ≈ v5 (token-driven, within noise) | Medium |
| Maintainability | **Best** — clean 9-section structure, corrections in one place | High (structural) |

## Validation

Run under the identical dev-10 harness (same dataset `navio-kb-dev-subset-v1`,
same 2 judges, same config) as a NEW experiment `cmp-v6-dev10-20260729-*`, not
overwriting any previous experiment. Primary success check: **does `sample-028`
finally pass hallucination + correctness?** Secondary: no regression vs v5 on
the other 9 samples; token/cost lowest of all. Confirm the winner with a full
60-sample `eval:run` before any production switch.
