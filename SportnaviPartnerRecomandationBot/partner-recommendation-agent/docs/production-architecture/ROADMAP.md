# Navio — Migration Roadmap

**Companion to** [`ARCHITECTURE.md`](./ARCHITECTURE.md). This document sequences
work; it does not re-derive it. Every item below cites its origin —
`recommendation.md`'s own ID (`I1`–`I11`, `M-1`–`M-9`, `L-1`–`L-4`) or a **NEW**
item introduced in `ARCHITECTURE.md`. Effort ratings (Low/Medium/High) are
carried over unchanged from `recommendation.md` where an ID exists.

**Ordering principle:** security and grounding floor first (already active
defects), then retrieval quality (pure wins, no cost), then the config decision
that everything else's cost measurement depends on, then net-new production
hardening, then data-asset exploitation, then scale, and — only once all of the
above make the system measurable — architecture comparison, which is the
project's actual long-term goal (`PROJECT_CONTEXT.md` §1).

---

## Phase 0 — Evaluation layer (✅ done, reference only)

`evals/`: 10 grounded edge cases, 14 evaluators across 3 tiers, calibration
harness. This phase is why every later phase can be measured instead of argued
about. No further action; verified present and intact (Step 0 of the design
plan, live-checked 2026-08-02).

---

## Phase 1 — Security + grounding floor

*Already-active defects. This phase has no new design content — it is "do the P0
items `recommendation.md` already specified," reordered here only to confirm
sequencing.*

| Item | Action | Effort | Ships with |
|---|---|---|---|
| I1 | Enable RLS + read-only policies on the 6 publicly-writable tables; revoke anon write grants | Low | — |
| I2 | Remove `limit 10` from `get_partner_profiles`; warn on short hydration; drop profile-less partners | Low | Pairs with the NEW `assertComplete()` helper below rather than a one-off fix |
| I3 | Replace the client-side centroid query with the `city_centroids()` SQL aggregate | Low | Same `assertComplete()` pairing |
| **NEW** | `assertComplete(requested, received, context)` helper, wired into every batch/bulk fetch (`get_partner_profiles`, `get_partners_by_city`, `city_centroids`) | Low | `ARCHITECTURE.md` §3 — this is the single guardrail that would have caught both I2's and I3's underlying defect class on day one; implement it *as part of* I2/I3, not after |

**Status note:** I1–I3 were already applied and live-verified as of 2026-08-01
per `recommendation.md`'s remediation table. This phase's only remaining
deliverable is the `assertComplete()` helper, which was not part of the original
fix — it generalizes the fix so the next silent-truncation bug doesn't need its
own incident to be found.

---

## Phase 2 — Retrieval scoring + work-performed metrics (ship together)

*Pure quality wins, no latency cost, no LLM involved — deliberately paired with
the metrics that would have caught the last round of defects, per
`ARCHITECTURE.md` §0's governing rule: never ship an efficiency/quality change
without its paired health signal.*

| Item | Action | Effort |
|---|---|---|
| I4 | Fix the degraded-embedding path: rank by `rrf_score`, bypass the cosine floor | Low |
| I5 | Pass `filters.tags` into `match_partners` | Trivial |
| M-3 | Carry `rrf_score` through `SimilarityHit`; rank/threshold on it instead of raw cosine | Medium |
| M-4 | OR the FTS terms instead of ANDing them | Low |
| I6 | Fix the 3 remaining dead-tool references in `instructions.md` (lines 139, 257, 338) — rewrite to `find_partners`, never delete the rule | Trivial |
| I7 | Add `intentText` to the search-cache key (stop cross-intent collisions) | Trivial |
| I8 | Derive the disclosure from `chosen`, not the resolved set; clamp `finalRecommendations` to `maxPartners` | Low |
| M-2 | **Work-performed metrics**: profiles-hydrated ÷ partners-shortlisted ratio, cities-in-centroid-map ÷ distinct cities, `profile_content_missing` rate | Low |

**Why these land together:** M-3/M-4/I4/I5 change ranking behavior; M-2 is the
metric set that proves the change is a real improvement rather than a
plausible-looking regression — exactly the trap `CLAUDE.md` §11 documents.

---

## Phase 3 — Settle the cost question

*Everything about token/cost/latency for the wide-context config was measured
before `I2` (the `limit 10` fix) — those measurements are invalid
(`recommendation.md` M2). This phase re-measures for real and closes the open
decision.*

| Item | Action | Effort |
|---|---|---|
| M-5 | Re-measure `DEFAULT_CONFIG` (wide-context: 100/100/10/100/0.15/150/20) against a tuned profile now that hydration actually works; decide ship-or-revert to `PRODUCTION_BASELINE`, record the delta | Low, but requires the decision-owner's sign-off — `CLAUDE.md` §7/§13.5 flags this as "ask first, do not silently fix" |
| **NEW** | Add a per-profile p95 truncation guard (cap outlier profile length in `renderTier2`) | Low — `recommendation.md` D4 |
| §10.4 fix | Correct the LangSmith `invoke_agent` double-count; surface true (cache-discount-adjusted) cost or label the dashboard figure as relative-only, in the UI itself | Medium |

---

## Phase 4 — Production hardening (net-new)

*The genuinely new production-platform work — everything in this phase is
absent today, not broken. Sequenced after Phases 1–3 because none of it is
useful until the underlying retrieval/grounding floor is solid — hardening a
system that still silently fabricates is the wrong order of operations.*

| Item | Action | Effort | Source |
|---|---|---|---|
| M-8 (part) | Auth boundary on the dev console (shared-secret/basic-auth is sufficient for an internal operator console; upgrade only if it becomes end-user-facing) | Medium | `ARCHITECTURE.md` §7 |
| M-8 (part) | Injection-hardened profile-content delimiters in the prompt/render layer | Low | `ARCHITECTURE.md` §3, `recommendation.md` U7 |
| **NEW** | Per-request token/byte budget guardrail on rendered tool-result size (works together with the p95 truncation guard from Phase 3) | Low | `ARCHITECTURE.md` §5 |
| M-9 | Parameterize the `vec` CTE's `limit 40`; add the `partner_intelligence`→`partners` FK | Low | Also listed as M1/M4 in `recommendation.md` |
| I11 | `CREATE INDEX partners_city_idx ON partners (city)` (+ expression index on `slugify_tag(city)`) | Trivial | Cheap insurance, do opportunistically any time after Phase 1 |
| I9 | Embed once before the gap-fill fan-out (already partially shipped per §11.1 — confirm and close); add fetch timeouts (`AbortSignal.timeout`) | Low | Removes a hang path (M3 in `recommendation.md`) |
| I10 | Fix the 7 stale "Curator was used" assertions in `tests/agent-test/`, or formally retire the directory | Low | Prerequisite for ever trusting that harness again — otherwise leave it archival/inert as it is today |
| M-6 | Shared cache (Redis) + single-flight + bounded embedding cache | Medium | **Only if/when scaling to multiple instances is an actual decision** — do not build ahead of that need |

---

## Phase 5 — Data-asset exploitation

*Turns "we don't have that" into real answers for parts of the directory that
already have the data — the highest-visibility product win still on the table,
per `ARCHITECTURE.md` §1.*

| Item | Action | Effort | Must ship with |
|---|---|---|---|
| L-1 (a) | Extend `overflowStrategy: "quality"` / gap-fill ranking to use `partner_intelligence.quality_score` more broadly | Low | — |
| L-1 (b) | Surface `okf_profiles.opening_hours` (335 partners, verified) as queryable | Medium | An `instructions.md` rule #10 update (hours *are* available for this subset) **and** a new eval case — shipping the data without updating the rule that currently says "hours are not queryable" recreates exactly the field-by-field honesty inconsistency rule #10 exists to prevent |
| L-1 (c) | Use `courses` (7,759 rows) for course-level matching, not just flattened `courses_text` | High | Genuinely new retrieval dimension — needs its own eval cases before it's trusted, sequence last within this phase |

---

## Phase 6 — Scale the data layer

*Irrelevant at 2,333 rows; a real wall at 10×. Not urgent, but the two hard walls
already identified should not be discovered under load.*

| Item | Action | Effort |
|---|---|---|
| L-2 | Restructure `match_partners` for HNSW push-down (filter push-down instead of CTE pre-filtering) | High |
| M-4 (index part) | Ensure `partners_city_idx` and `partners_tags_norm_idx` are actually exercised once the tag branch (Phase 2) is live | Low |

---

## Phase 7 — Architecture comparison (the project's stated long-term goal)

*Only now — after Phases 1–6 make the system's quality, speed, cost, and
reliability actually measurable via the real eval suite, not opinion.*

| Item | Action |
|---|---|
| L-4 | Build alternative workflows (router, planner/executor, multi-agent, alternative retrieval strategies) as **siblings** of `partner-recommendation-agent/`, per `PROJECT_CONTEXT.md` §1's stated vision — never as a replacement of the current shape without a measured reason |
| L-3 | Explore the `okf` knowledge graph (`okf_recommendations`, `okf_neighbors`) as one such alternative retrieval strategy, once there's a way to measure whether it actually helps |
| — | **NEW, gated on Phase 5(b)/(c):** if long-term memory / personalization is prioritized, design the minimal `user_preferences` schema here, keyed to a real identity established by Phase 4's auth work — not before |

---

## What is explicitly out of scope for this roadmap

Restated from `ARCHITECTURE.md` and `CLAUDE.md`/`recommendation.md`'s own
closing sections, because a roadmap that doesn't say what it's *not* doing
invites scope creep:

- More agents, subagents, or orchestration layers, without a measured eval
  showing they win.
- Specialized per-facet tools (by-city, by-category, by-specialty) — each costs
  schema tokens on every model call; the 17→2 consolidation is the whole point.
- Model routing / cheaper-model fallback, without evidence it's needed and
  without the same grounding gate applied to every routed path.
- A confidence-scoring output guardrail (risks implying graded trust in a
  system whose entire design goal is binary grounded/not-grounded).
- Per-user spend limits, RBAC, or a secret-manager service ahead of an actual
  auth/deployment decision that would make them load-bearing.
- Long-term memory / personalization ahead of Phase 4's auth layer existing.
