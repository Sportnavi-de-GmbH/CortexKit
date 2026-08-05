# Navio — Production Architecture

**Status:** design document, not yet implemented. **Last verified against source:
2026-08-02** (same day as `PROJECT_CONTEXT.md`).

> **Read this after, not instead of,** [`CLAUDE.md`](../../../CLAUDE.md),
> [`PROJECT_CONTEXT.md`](../../../PROJECT_CONTEXT.md), and
> [`recommendation.md`](../../../recommendation.md). Those three documents are the
> authority on **what exists today and what is verifiably broken** — SQL
> reproduction steps, measured token counts, live-verified row counts. This
> document does not repeat that evidence; it cites defect IDs (`C1`, `H2`, `M-3`,
> etc.) by reference and answers a different question: **what should this system
> look like as a production platform, and in what order do we get there.**
>
> Every recommendation below either (a) extends a module that already exists and
> is named explicitly, or (b) is marked **NEW** with a one-line justification. If
> you are tempted to add something not in this document, first ask whether
> `recommendation.md`'s own priority order (quality → speed → cost → reliability →
> scalability → simplicity → maintainability) and its closing line — *"Do not add
> agents, orchestration layers, or specialized per-facet tools... every problem
> found in this review is a data-layer problem wearing an AI costume"* — already
> answered the question.

---

## 0. The one rule this document exists to serve

`CLAUDE.md` §11 and `PROJECT_CONTEXT.md` §12 document, in detail, that the two
worst incidents in this project's history were both **invisible to every metric
being tracked at the time** — a fabricating agent that looked cheap and fast, and
six defects (including two critical ones) that produced perfectly healthy
telemetry while the agent silently fed the model blank partners and half a city
map.

**Every guardrail, metric, or architectural change proposed below is required to
answer one question: if this silently degraded, how would we know?** Where a
proposal can't answer that, it is marked as such rather than included as a
solved problem.

---

## 1. Recommendation engine — what changes, what stays

**What stays:** the hybrid retrieval design itself (vector + FTS + name-trigram +
tag-overlap fused by RRF in `match_partners`), the deterministic
fetch→gap-fill→cap→hydrate pipeline in `lib/partners/`, and the home-city-whole
golden rule. `recommendation.md` confirms the *database* already computes the
right signal (`rrf_score`) and the right structure — the defects are entirely in
**application code discarding or misusing what the database already provides.**
This is a "wire it up correctly," not "redesign it," problem.

| Change | What it fixes | Current defect | Effort |
|---|---|---|---|
| Carry `rrf_score` through `SimilarityHit`; rank and threshold on it instead of raw cosine `similarity` | Retrieval quality — RRF is comparable across queries, raw cosine on `text-embedding-3-small` is not | H3, and the reason `similarityThreshold` needed hand-tuning from 0.35→0.15 | Medium |
| Pass `filters.tags` into `match_partners` | Activates the tag-overlap RRF branch and `tag_synonyms`/`okf.tag_variants` expansion (89 synonym rows), currently dead | H2 | Trivial |
| OR the FTS terms (`websearch_to_tsquery` currently ANDs) | Restores the keyword branch for realistic multi-word German intents | H4 (0 matches on `'yoga entspannung anfänger'`) | Low |
| Degraded-embedding path: rank by `rrf_score` and bypass the cosine floor when `queryEmbedding === null` | Makes the documented fallback actually return partners instead of zero | H1 (verified: returns 0 today) | Low |
| Parameterize the `vec` CTE's hardcoded `limit 40` | Makes `dedupHeadroom`/`k` meaningful again | M1 | Medium |
| Use `partner_intelligence.quality_score` for `overflowStrategy: "quality"` (already wired) and extend to gap-fill ranking as a tiebreak | The eval's recurring complaint: the agent can't distinguish a rich profile from a one-line template | L-1 (part) | Low |
| Surface `okf_profiles.opening_hours` (335 partners, verified) as a queryable field, and update rule #10 to say hours *are* available for that subset | Turns "I don't have that" into a real answer for 14% of the directory — the highest-visibility product win available | L-1 (part) | Medium — **must ship together with an `instructions.md` update and an eval case**, not as a silent data change (rule #10 exists because the model handles "have this fact / don't have this fact" inconsistently field-by-field) |
| Use `courses` (7,759 rows, currently only flattened into `courses_text`) for real course-level matching | More precise gap-fill than city-level similarity alone | L-1 (part) | High — genuinely new retrieval dimension, sequence last within this list |

**Explicitly not changing:** the two-tool budget, the two-model-step shape, the
home-city-whole rule, and the RPC-based architecture itself. No new retrieval
service, no separate vector database, no re-introduction of a three-tool chain.

---

## 2. AI infrastructure

### 2.1 Session / state model

eve already provides session state, streaming, tool dispatch, and compaction
(`PROJECT_CONTEXT.md` §5.5). **Nothing crosses a model turn as an opaque handle**
— the old `setId`/`resolved-set-store.ts` handoff was deliberately removed because
one tool now does the whole search, and that removal is itself a guardrail (there
is nothing left for the model to fabricate a reference to). **Keep this shape.**
Do not reintroduce cross-turn state unless a concrete feature (e.g. long-term
memory, §4.2) requires it, and if it does, it should live in Postgres, not in a
new in-process store — see §5's caching-and-state-scaling notes.

### 2.2 Durable / background execution

**There is currently no durable-execution or background-task need, and none
should be added speculatively.** Navio's entire product surface is synchronous
request/response chat — a user asks, the agent searches, the agent answers. There
is no multi-hour workflow, no batch job, and no write path (§2.4). The one
plausible future use (a partner-data **ingestion/import pipeline** that needs
retries, checkpointing, and progress visibility) does not exist yet and is out of
scope for this document; when it is built, it is a natural fit for eve's durable
execution model specifically because it *would* be long-running and resumable —
unlike every request Navio currently serves.

### 2.3 MCP integration

Supabase MCP and LangSmith MCP are already used — but **at development time only**
(schema inspection, dataset/eval management), configured in the gitignored
`.mcp.json`. **They are not, and should not become, part of the runtime agent.**
The runtime agent talks to Supabase via the service-role `@supabase/supabase-js`
client and to Azure OpenAI directly (`lib/supabase.ts`, `lib/llm.ts`) — a
narrower, audited surface than an MCP tool would expose to the model. No change
recommended here; this section exists only to make the boundary explicit, since
the mission's brief specifically asked about MCP integration.

### 2.4 Human-approval / HITL workflows

**None exist and none are needed.** Navio takes no irreversible action — it reads
a directory and writes prose (`PROJECT_CONTEXT.md` §5.7). There is no booking, no
payment, no write path to any table reachable from the agent. `rule #10`'s
`no_false_capability_claimed` evaluator exists precisely because users *ask* for
booking and the honest answer is that Navio cannot. If a future feature adds a
write action (e.g. submitting a lead to a partner), a HITL confirmation step
becomes relevant then — not before. Do not build approval-workflow scaffolding
against a capability that does not exist.

### 2.5 Secure tool execution

Already handled at the surface level: `bash`, `write_file`, `read_file`, `glob`,
`grep`, `todo`, `agent` all call `disableTool()` — nine files, all measured
(1,469 tokens/call saved) and two of them (`bash`, `write_file`) named explicitly
as RCE surfaces reachable through prompt-injected chat text. `web_search`/
`web_fetch` stay disabled because the directory is the only source of truth
(§14.5 of `CLAUDE.md`, restated as a "must not change" item). **One open item,
not new:** eve still provisions a Docker sandbox per turn despite every
sandbox-backed tool being disabled (17 opens measured, one took 5s) —
`recommendation.md` L1.11. This is an eve-runtime behavior, not application code;
track it as an upstream issue, don't attempt to work around it inside `agent/`.

### 2.6 Model management

One model (Azure `gpt-4.1`, `germanywestcentral`), one embedding model
(`text-embedding-3-small`, pinned at three enforcement points per
`PROJECT_CONTEXT.md` §8.2 item 5). **No model routing or cheaper-model fallback is
recommended** — see §5 (Cost management) for the reasoning; this is a single-model
product where the win is in retrieval and prompt discipline, not in swapping
models per request.

---

## 3. Guardrail layers

The mission asks for Input / AI / Output guardrail layers. The system already has
eight, documented as a flat list in `PROJECT_CONTEXT.md` §5.6. Restated here in
the requested three-layer taxonomy, with the genuinely new items called out
explicitly (marked **NEW**) rather than invented wholesale:

### Input guardrails
| Guardrail | Mechanism | Status |
|---|---|---|
| Prompt-injection resistance (chat text) | `web_search`/`web_fetch`/`bash`/`write_file` disabled; profile text treated as data not instructions (rule #7); grounding mandate takes precedence over embedded instructions | Existing |
| Malicious input in partner profile content (`body_markdown`, `llm_profile`) | Rule #7 tells the model to ignore embedded instructions; **no structural delimiter exists today** | **NEW recommended:** wrap profile blocks in an explicit, consistently-labeled delimiter (e.g. a fixed marker the system prompt tells the model to never treat as an instruction boundary) — cheap, and `recommendation.md` U7 already flags this as a real gap with no eval coverage |
| Argument validation on `find_partners`/`get_partner_details` | Zod schemas at the tool boundary | Existing |
| `finalRecommendations` unbounded | `z.number().int().positive()`, no `.max()` | **NEW (small fix):** clamp to `maxPartners` — this is also the root cause of H6/A6 (disclosure describing partners never shown) |
| `get_partner_details` accepts any id with no membership check | Any positive integer works even if not previously surfaced | **Known gap, not fixed:** L1.2 in `recommendation.md`. Low severity — the directory is public — but it weakens the grounding chain. Track, don't block on it |

### AI (model-behavior) guardrails
| Guardrail | Mechanism | Status |
|---|---|---|
| Tool budget | Exactly 2 live tools; every additional tool requires an eval proving it earns its schema-token cost | Existing, enforced by convention (`CLAUDE.md` §12 item 10) |
| Execution limits | Two model steps per search is the canonical health signal (`app.model_steps`); a value of 4 signals the old chain reappeared | Existing, monitored (§4) |
| Grounding mandate | "You do not know any partners. Not one." — top of `instructions.md`, before persona | Existing, load-bearing, must not move |
| Risk scoring / approval requirements | Not applicable — no irreversible action exists (§2.4) | N/A by design |
| Budget limits (token/cost per request) | **None today** | **NEW recommended**, see §5 |
| Context limits | `modelContextWindowTokens: 1_047_576` override; no per-request cap on rendered profile bytes | The wide-context experiment (100 profiles ≈ 41,900 tokens) is the reason this matters — see §5 and `ROADMAP.md` Phase 3 |
| Model behavior controls (rules #1–#10) | The ten non-negotiable rules in `instructions.md`, each backed by a reproduced-failure rationale | Existing, must not be "cleaned up" without re-running the eval (`CLAUDE.md` §5) |

### Output guardrails
| Guardrail | Mechanism | Status |
|---|---|---|
| Grounding / no fabrication | `grounding_no_fabricated_partners` eval gate (hybrid: LLM extracts, code decides) | Existing (Phase 0, `evals/`) |
| Confidence scoring | **None** — there is no per-recommendation confidence signal surfaced anywhere | Not recommended as new work: the honesty-first design already forces binary "grounded or not," and a confidence score risks *implying* graded trust in a system whose whole point is that ungrounded content should never appear at all. Skip. |
| Hallucination prevention | Data-level: partners with empty profile text are dropped before rendering (fixed defect C1); type-level: `PartnerLite` has no PII fields | Existing |
| Explanation generation | The model reads full profiles and must cite a concrete detail (prompt section "Using everything you were given") + the genericness self-check | Existing, prompt-level only — no code-level check that an explanation is actually specific (would require an LLM judge; already covered diagnostically by the `personalization_not_generic` eval, which is judge-only and does not gate) |
| Structured outputs | `find_partners`/`get_partner_details` return typed, Zod-validated results; `toModelOutput` trims to Tier-2 + disclosure | Existing |
| Sensitive-data protection | `PartnerLite` never carries `email`/`phone`; `SELECT_COLUMNS` omits them; warnings are laundered through `WARNING_PHRASES` before reaching the model | Existing (§4.4 of `PROJECT_CONTEXT.md` — this is a *consistency* control, not a privacy one; contact data is intentionally public) |
| **NEW — silent-truncation guard** | An `assertComplete(requested, received, context)` helper, called at every batch/bulk fetch boundary (`get_partner_profiles`, `get_partners_by_city`, `city_centroids`) | This is `recommendation.md`'s own top strategic recommendation (§"Future Architecture Considerations" item 2): C1 and C2 were the *same* defect wearing different clothes — a query returned fewer rows than requested and nothing noticed. ~20 lines of code, would have caught two of the three critical findings on day one. **This is the single highest-leverage guardrail in this entire document.** |

---

## 4. Observability as a system

The existing Sentry + LangSmith (EU) wiring is well-designed (`PROJECT_CONTEXT.md`
§10 calls out the single-OTel-provider trick and the trace-merging logic as
genuinely non-obvious, correct engineering). The gap is not instrumentation
plumbing — it's **which signals are being watched**, and `CLAUDE.md` §9 already
names the fix:

### 4.1 The metric pairing principle (already established, now formalized)

> Every efficiency/health metric must be paired with a work-actually-performed
> metric, or it will read green while the product silently breaks.

| Efficiency/health signal (existing) | Work-performed pairing (existing or NEW) |
|---|---|
| `app.tools_used` populated | Grounding eval gate (Phase 0) |
| `app.model_steps == 2` | — (this one is already a work signal, not paired further) |
| Cache-read share (~93%) | **NEW:** alert if prefix-cache hit rate drops below a threshold (e.g. 85%) — a drop means the prompt destabilized (a timestamp, a user name, rotating content leaked into the prefix) and silently multiplies cost up to 4× |
| Resolution events fired | Should equal the count of city-mention requests — **NEW:** alert on a sustained gap |
| — | **NEW: profiles hydrated ÷ partners shortlisted.** <1.0 means the model is being handed blank partners. This metric alone would have caught C1 on day one. |
| — | **NEW: cities present in the centroid map ÷ `count(distinct city)` in `partners`.** A drop is silent truncation. Would have caught C2 on day one. |
| — | **NEW: `profile_content_missing` warning rate.** Non-zero and rising means hydration or upstream data quality is degrading. |

These three NEW metrics are already fully specified in `recommendation.md` M-2 —
this document does not redesign them, it elevates them from "recommended metric"
to "Phase 2 blocking work" in `ROADMAP.md`, because they are cheap, code-only
(the pipeline already computes the numerator and denominator of each), and they
are the direct answer to §0's governing question.

### 4.2 Cost-telemetry correctness

LangSmith cost is currently wrong by ~8× (`invoke_agent` double-counting ×2,
prompt-cache discount ignored ×~3.4 — `PROJECT_CONTEXT.md` §10.4). This is not
cosmetic: it means the one dashboard an operator would check to sanity-check a
cost regression is silently unreliable. Fix sequence:
1. Correct the double-count at the LangSmith span/filter layer (the nested
   `invoke_agent` span should not report the same usage as its child `chat` span).
2. Either surface the cache-discount-adjusted true cost as a computed field, or
   explicitly label the LangSmith figure "relative regression signal only, not a
   billing figure" in the dashboard itself — not just in documentation, since a
   number without that caveat visible in the UI will eventually be trusted at
   face value by someone who hasn't read this document.

### 4.3 Dashboards & alerts (sketch, not a new observability platform)

No new tool is needed — Sentry already receives the six-class failure taxonomy,
LangSmith already receives traces. What's missing is composing the existing
signals into two operator-facing views:
- **A health dashboard**: the 7-row table above, refreshed per request, with the
  three NEW work-performed metrics as the headline (since they're the ones that
  would have caught real incidents).
- **Alerting**: threshold alerts on cache-hit-rate drop, hydration-ratio drop
  below 1.0, and centroid-city-count drop — each maps directly to a previously
  real, previously invisible defect (C1, C2, and the caching regression class).

---

## 5. Cost management

**Current state:** token/cost tracking exists via LangSmith (with the known 8×
error, §4.2). The single highest-leverage cost lever already identified in this
codebase is the wide-context config experiment: `finalRecommendations: 100` under
the active `DEFAULT_CONFIG` renders **100 full profiles / ≈41,900 tokens per
search**, uncached, on top of the ~11k-token cached prefix — and the 93%
cache-hit figure this project is proud of doesn't even measure this, because tool
results aren't prefix-cached (`PROJECT_CONTEXT.md` §7).

| Action | Status |
|---|---|
| Settle the wide-context experiment — measure now that C1 (the `limit 10` bug) is fixed, since every earlier measurement of this config is invalid (`recommendation.md` M2/M-5) | **NEW-priority, not new-work** — this is `ROADMAP.md` Phase 3, already specified |
| Per-request budget guardrail: a soft cap on total tokens rendered into a single tool result (e.g. p95 profile-length truncation, `recommendation.md` D4) | **NEW.** No cap exists today; one 20k-char outlier profile can add ~5k tokens alone with no ceiling |
| Per-user / per-session spending limits | **Not recommended now.** There is no user-account system and no billing relationship with end users (the dev console is unauthenticated, single-operator). Building per-user budgets ahead of having users to attribute them to is exactly the kind of premature infrastructure the mission's own constraints ask to avoid. Revisit only alongside an auth layer (§7). |
| Automatic spend alerts | Azure/LangSmith-native budget alerts at the deployment/org level are sufficient — no bespoke code needed |
| Model routing / cheaper-model fallback | **Explicitly not recommended.** One model, one deployment is already the minimal footprint; routing adds a decision surface (which query goes to which model) with no evidence it's needed, and risks becoming a second, subtler version of the §11/§12 "the cheap path was the fabricating path" trap — a router that under strain silently favors the cheaper/dumber path IS that trap. If cost ever forces this conversation, it must ship with the same grounding eval gate applied to both paths, not as a bypass. |
| Cost optimization in general | Governed by the existing rule: **every cost change must be paired with a work-performed metric before it's trusted** (§0). This is not new policy — it's `CLAUDE.md` §11/§12 restated as a cost-management principle specifically. |

---

## 6. Memory & data architecture

### 6.1 Short-term memory
Conversation/session state — eve-native, already correct (§2.1). No change.

### 6.2 Long-term memory
**There is currently none, and this is a real gap relative to the mission's ask —
stated plainly rather than glossed over.** No user-preference store, no
recommendation history, no feedback loop, no "user previously said they prefer
mornings" persistence. The search-cache in `lib/partners/search-cache.ts` is an
in-process TTL cache of *searches*, not a memory system, and is explicitly
documented as "not a store and not safe for personalized results."

**Recommendation: do not build this speculatively.** The mission's own
constraints ask to avoid unnecessary frameworks and design for a stated need, not
a hypothetical one. Navio today has no user-account concept, and long-term memory
without an identity to attach it to is either (a) session-scoped (which eve
already gives for free within a conversation) or (b) device/browser-scoped
(fragile, low value for a directory-lookup product where repeat-visit
personalization isn't obviously the highest-value next feature vs. e.g. fixing
retrieval scoring). **If and when personalization is prioritized**, the minimal
addition is a single `user_preferences` table keyed by a real identity (requires
auth first, §7) with a small number of explicit, user-confirmed fields (preferred
city, stated driver categories) — never inferred silently, per the same honesty
principle that governs the rest of this product. This is deliberately not
designed further here; it is a Phase 7+ item in `ROADMAP.md`, after the retrieval
and security floor is fixed.

### 6.3 Knowledge system
The existing pgvector + hybrid-RPC search over `partners` is the knowledge system,
and it's sound in design — see §1 for what's wrong with how the *application*
uses it. Unexploited assets already inventoried in `PROJECT_CONTEXT.md` §6.3
(`courses`, `okf_profiles.opening_hours`, `okf.*` knowledge graph,
`tag_synonyms`) are covered in §1's table (L-1) and `ROADMAP.md` Phase 5.
**No new knowledge store, no new embedding space, no separate vector database.**
Embedding-space discipline (`text-embedding-3-small`, pinned, enforced at three
points) is a "must not change" invariant — mixing spaces corrupts similarity
silently.

---

## 7. Security architecture

Consolidating the already-verified findings into a posture, not a punch list:

| Domain | Current state | Target |
|---|---|---|
| **Data write integrity** | C3 (fixed 2026-08-01): six tables were writable by the public `anon` key, including `tag_synonyms` which steers live retrieval. Migration `lock_down_anonymous_writes` applied. | Maintained — no further action, but note as a **class** of risk: any future table needs RLS decided *before* it ships, not discovered by an advisor scan after the fact. |
| **Data read** | `partners`, `partner_intelligence`, `courses` — RLS on, no policies, blocks anon entirely. Agent uses service-role key, bypasses RLS by design. | Correct, unchanged. Contact data (`email`/`phone`/`street`) is intentionally public directory information — this is **not** a privacy boundary to add. |
| **Auth boundary (application)** | **None.** The dev console (`app/`) has no authentication and proxies `/eve/v1/*` unauthenticated. Fine for local/single-operator use; a real deployment exposes an unauthenticated LLM endpoint — cost-drain and prompt-injection surface (L1.1, S8). | **Required before any deployment**, not required today. Add an auth layer (even a simple shared-secret/basic-auth gate is sufficient for an internal operator console; a real end-user-facing surface needs proper session auth) as a named Phase 4 item in `ROADMAP.md` — do not build it speculatively ahead of an actual deployment decision. |
| **Secret management** | `.env.local` (gitignored, not `.env`), `.mcp.json` (gitignored, holds a live LangSmith key — `CLAUDE.md` item 7, unresolved). Service-role Supabase key required (anon key silently returns zero rows). | Rotate the LangSmith key if `.mcp.json` was ever shared outside this environment (open item, low effort, should not be deferred indefinitely just because it's "contained"). No secret-manager service is justified at current scale — env-file discipline is sufficient and matches "avoid unnecessary infrastructure." |
| **RBAC** | **Not applicable.** Single agent, no user accounts, no differentiated permission levels — there is exactly one thing the system does (search and answer) and one credential class (service-role, used only by the agent process). | Deliberately deferred. Revisit only if/when the dev console gains multiple real operator roles or an end-user-facing deployment with accounts — building RBAC ahead of that is speculative infrastructure the mission's constraints ask to avoid. |
| **Audit logging** | Resolution events (`emitResolutionEvent`) already log every search, PII-free, fire-and-forget. There is **no admin/query audit trail**, but there is also no admin surface to audit — this gap is a consequence of "no auth boundary," not a separate defect. | Falls out of the auth-boundary work in Phase 4: once there's an authenticated admin action, log it. Don't build an audit log for actions that don't exist yet. |
| **Function security** | `slugify_tag` given a fixed `search_path` (2026-08-01 fix — mutable search_path on a `SECURITY DEFINER`-reachable function is a privilege-escalation primitive). | Maintained. Apply the same review (`SECURITY DEFINER` + `search_path`) to any new RPC, including the ones proposed in §1/`ROADMAP.md`. |

**Governing principle carried over from `recommendation.md`'s own closing
section:** give every `SECURITY DEFINER` function and every non-default grant a
named owner and a review date, and assert the contract from the application side
(the `assertComplete()` guardrail in §3) rather than assuming a database contract
holds forever once written.

---

## 8. Technology stack — recommendation: keep it

Evaluated against the project's own stated priority order (quality → speed →
cost → reliability → scalability → simplicity → maintainability):

| Layer | Current | Verdict | Reasoning |
|---|---|---|---|
| Agent runtime | eve `^0.25.2` | **Keep** | Provides sessions, streaming, tool dispatch, compaction, and the OTel wiring this project depends on for free; no observed need it doesn't meet |
| Model | Azure OpenAI `gpt-4.1` | **Keep** | Single deployment keeps the cost/observability story simple (§5); no evidence a routing layer or a different model would move the quality needle more than fixing retrieval (§1) would |
| Data layer | Supabase Postgres + pgvector | **Keep** | Hybrid RRF search is architecturally sound (§1); the fixes needed are application-code fixes, not a data-layer replacement. A separate vector database would duplicate a working embedding index for no measured benefit and would break the single-space discipline that's currently enforced in one place |
| Dev console | Next.js 15 / React 19 / Tailwind 4 | **Keep** | Serves its actual purpose (operator chat + telemetry dashboard); needs an auth layer before any real deployment (§7), not a framework change |
| Observability | Sentry + LangSmith (EU) | **Keep** | The non-obvious wiring (single OTel provider, trace merging) is genuine engineering investment already paid for; the gap is metrics-watched, not instrumentation (§4) |
| Orchestration | None (single agent, two tools) | **Keep — explicitly reject alternatives** | Router/planner/multi-agent are all rejected by `recommendation.md`'s own closing recommendation and `CLAUDE.md` §13's "explicitly not recommended" list: the measured problem in this project's history was too many model hops, not too few. Nothing in this redesign changes that conclusion. |
| Memory store | None (session-only) | **Keep — do not add speculatively** | See §6.2 |

**No new external dependency is introduced by this document.** Every
recommendation above either fixes a wiring defect in existing infrastructure or
extends an existing module.
