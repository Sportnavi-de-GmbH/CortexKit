# v1 — Knowledge Base Deduplication

**Strategy category:** Removing redundant context
**Status:** Candidate only — NOT applied to `agent/instructions.md`. Not activated in any experiment.
**Full evidence base:** [`../../analysis/TRACE_EVIDENCE.md`](../../analysis/TRACE_EVIDENCE.md) §1

---

## In plain terms (non-technical summary)

The agent's instructions currently include **two different copies of the
same FAQ document** — `doc1.md` and `doc2.md` — written by different people
at different times, covering the same questions about Sportnavi. `doc2.md`
is the newer, cleaner, more complete version; `doc1.md` is an older, rougher
export that doesn't add any question `doc2.md` doesn't already answer.

This candidate simply **removes the older, duplicate copy** (`doc1.md`) and
keeps everything else — the persona, the rules, and the other four knowledge
documents — completely unchanged. Nothing the agent can currently answer
becomes something it can no longer answer.

## What problem was identified from the traces

Measuring the live production prompt file directly (not estimated):

- The embedded Knowledge Base is **89.3% of the entire prompt** (~19,105 of
  ~21,400 tokens). Every other section (persona, rules, hard limits) is
  small by comparison. This means KB size is the single largest lever
  available for token/cost/latency optimization.
- `doc1.md` and `doc2.md` have a **73.4% word-level content overlap**.
  `doc1.md` has 44 section headings; every one of them maps onto a heading
  that already exists in `doc2.md` (sometimes with cosmetic differences like
  unescaped `&amp;` instead of `&`, or missing section numbers). `doc1.md`
  contributes **zero unique topics**.
- `doc1.md` additionally carries formatting noise: 9 unescaped `&amp;` HTML
  entities left over from an unprocessed content export — tokens spent on
  artifacts, not information.

Full measurement detail: [`TRACE_EVIDENCE.md` §1](../../analysis/TRACE_EVIDENCE.md#1-prompt-token-footprint-measured-directly-from-agentinstructionsmd).

## What bottleneck this targets

**Token volume → cost and throughput.** Per `TRACE_EVIDENCE.md` §5, the
agent is TPM-bound (Azure tokens-per-minute), not RPM-bound: at ~20,000
tokens/turn and a 50,000 TPM budget, throughput is capped at 2 turns/minute
regardless of how many requests-per-minute are allowed. Removing ~3,905
tokens of duplicate content from every single request directly raises that
ceiling.

## What was changed

- Removed the entire `<<< DOCUMENT: doc1.md >>> ... <<< END OF doc1.md >>>`
  block from the Knowledge Base section.
- **Nothing else changed** — same persona, same behavior rules, same
  conversational-intelligence guidance, same hard limits, same doc2–doc5
  content, byte-for-byte.
- The change was made with a scripted, assertion-checked text transform
  (not manual retyping) to guarantee the rest of the file is byte-identical
  to the original — there is no risk of an accidental edit elsewhere.

## Why this change may improve performance

`doc2.md` is a strict superset of `doc1.md` in content (every heading in
doc1 exists in doc2; doc2 additionally covers 26 topics doc1 never
mentions), so removing doc1 cannot remove any fact the agent is currently
relying on to answer real questions — it only removes duplicate restatement.

## Expected impact

| Dimension | Expected effect | Basis |
|---|---|---|
| Prompt size | **−3,905 tokens/turn (~18.2% of total prompt, ~20.4% of the KB)** | Direct measurement of the removed block |
| Cost per turn | Modest reduction — most of this content is cache-read (~$0.50/1M), so the dollar saving per turn is small (~$0.002/turn at cached rates), but see throughput below | `TRACE_EVIDENCE.md` §4 pricing |
| **Throughput (turns/minute at fixed TPM budget)** | **Increases proportionally** — from ~2 turns/min toward ~2.4 turns/min at the same 50,000 TPM budget (a ~20% throughput gain) | Direct arithmetic: `TRACE_EVIDENCE.md` §5 |
| Latency (TTFT) | Likely small reduction — TTFT is dominated by processing the cached prompt; a smaller cached prompt should process marginally faster, though this must be measured, not assumed | Reasoned inference; test to confirm |
| Answer quality | **No expected change** — no fact is removed, only a duplicate restatement | doc2 is a strict content superset of doc1 |
| Evaluation scores | No expected change to `correctness`/`hallucination`/etc., since the same information remains available in doc2 | — |

## Risks / trade-offs

- **Unverified edge case:** the 73.4% overlap measurement is a word-level
  approximation, not a guaranteed 100% semantic check. Before adopting this
  candidate, the reviewer should specifically re-run the 9 KB-grounded eval
  samples that reference doc1-style phrasing (if any) to confirm no answer
  regresses. The dataset's `kb_reference` metadata field on each example
  makes this straightforward to check.
- **Phrasing diversity loss:** doc1.md's slightly different wording of the
  same facts *could* theoretically have helped the model recognize a
  question phrased unusually. In practice, this is a full-context prompt
  (not retrieval-based), so the model reads all of doc2–5 regardless — this
  risk is considered low but is worth confirming with a same-question,
  different-phrasing regression test if the reviewer wants extra confidence.
- **No quality upside** — this candidate is a pure efficiency play. It does
  not address any of the evidenced quality issues (KB contradiction,
  language mirroring). See v2/v3 for those.

## How to test this later

1. Do **not** copy this file over `agent/instructions.md` directly in
   production — first review it manually.
2. To test locally: temporarily point `agent/agent.ts`'s instructions
   source at this candidate file (or manually swap it into a local branch),
   run `npm run typecheck && npm test`, then `npm run dev` and try a handful
   of manual questions covering topics that existed in doc1 (e.g. the
   partner-onboarding questions, `Wie werde ich Partner von Sportnavi?`) to
   confirm answers are unchanged.
3. For a rigorous comparison, run the existing 60-sample LangSmith
   evaluation (`npm run eval:upload` is already done; `npm run eval:run`)
   against this candidate and compare the experiment's aggregate scores
   (hallucination, correctness, answer_relevance, etc.) and its
   `input_tokens`/`cost_usd` metrics side-by-side with the baseline
   experiment `agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728`.
   Expect materially lower `input_tokens` and materially *unchanged*
   quality scores. Any quality regression means doc1 held content doc2
   doesn't — investigate the specific failing sample before proceeding.
