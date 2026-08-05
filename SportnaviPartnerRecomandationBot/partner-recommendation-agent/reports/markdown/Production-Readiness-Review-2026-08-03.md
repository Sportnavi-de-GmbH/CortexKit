# Production-Readiness Review — Navio Partner Agent

**Scope:** `partner-recommendation-agent/` (the only implementation today).
**Method:** read against source (`agent/agent.ts`, `agent/tools/*`,
`lib/partners/*`, `lib/llm.ts`, `agent/hooks/*`, `package.json`,
`node_modules/eve` type defs), not against README/`.eve/` (both stale — see
root `CLAUDE.md` §0). Verified 2026-08-03.

**Framework note:** this agent runs on **eve** (`eve@0.25.2`), not a bare
Vercel AI SDK `generateText`/`streamText` loop. eve wraps the AI SDK
(`ai@7.0.31`) internally — tool schemas are AI SDK tool defs, the model is an
AI SDK `LanguageModel` — but the agentic loop, retry policy, and step control
are **eve's**, not yours to configure via AI SDK's `stopWhen`/`maxRetries`
call settings. Every recommendation below is scoped to what eve actually
exposes (`AgentLimitsDefinition` in `agent-definition.d.ts`), with an AI-SDK
equivalent shown for context since it's what the SDK docs describe.

---

## Priority 1 — Highest Impact

### 1. No cap on reasoning steps / tool calls per turn

**Problem.** `agent/agent.ts` sets only `model` and
`modelContextWindowTokens`. There is no `stopWhen`/step cap anywhere in the
codebase, and eve's public `AgentLimitsDefinition` (the only run-shaping knob
eve exposes) has no per-turn step or tool-call ceiling at all — only
session-wide token totals (`maxInputTokensPerSession`, defaults to
**40,000,000**; `maxOutputTokensPerSession`, **unset** by default). Today the
design keeps this safe by construction (§4.1: 2 tools, 2 model steps per
search), but that safety is a *behavioral* property of the prompt, not an
enforced ceiling — the exact failure class in §11 (`instructions.md` drift →
model stops calling tools, or in the opposite direction, starts looping) has
no backstop.

**Why it matters.** A runaway loop (model re-calls `find_partners` with
slightly different `cityMention` spellings, or alternates
`find_partners`/`get_partner_details` indefinitely) is unbounded cost and
latency with no framework-level circuit breaker. This is the single
highest-leverage gap because everything else in this report assumes the loop
terminates.

**Impact: High**

**Recommended implementation.**
- eve has no `maxSteps` primitive to set — the closest thing is
  `AgentLimitsDefinition.maxOutputTokensPerSession`, which is session-scoped
  (spans every turn in a conversation, not one turn) and currently unset.
  Set it explicitly rather than relying on the 40M-input default:
  ```ts
  // agent/agent.ts
  export default defineAgent({
    // ...
    limits: {
      maxInputTokensPerSession: 2_000_000,   // ~generous multi-turn budget, not 40M
      maxOutputTokensPerSession: 200_000,
    },
  });
  ```
- For an actual per-turn step ceiling, this has to be enforced in
  `find_partners`/`get_partner_details` `execute()` via a lightweight
  in-process turn-call counter (eve doesn't expose the model's turn loop to
  tool code directly, so the practical backstop is: the search cache already
  makes a second identical call a no-op — see #3 — and the two-tool,
  two-step design is the real control). File an eve support question on
  whether a per-turn `stopWhen` equivalent exists in a newer eve release
  before building a workaround.
- If/when this repo evaluates a bare-AI-SDK sibling workflow (§2 roadmap),
  that implementation gets this for free:
  ```ts
  import { stepCountIs, generateText } from "ai";
  await generateText({
    model,
    tools,
    stopWhen: stepCountIs(4), // 2 model steps expected; hard ceiling at 4
  });
  ```

**Estimated impact.** Prevents unbounded-cost incidents (currently: no
ceiling = worst case is bounded only by the 40M-token session default, which
at ~$2.50/1M input tokens is a **~$100 single-session** tail risk).

---

### 2. Retry policy is the AI SDK/eve default everywhere

**Problem.** No file sets `maxRetries` on the model call, on
`getSupabase()` calls, or on `embedText`. `lib/llm.ts` returns a plain
`azure.chat(...)` `LanguageModel` with no `CallSettings` override, so eve's
default retry policy governs (AI SDK default is 2 retries with exponential
backoff when eve delegates to the underlying `ai` package). Separately,
`resolvePartners` has **no timeout** on the home-city fetch — a hung Supabase
call blocks the whole search with no ceiling, and it's a **hard error path**
(§4.3: "a failing home fetch is a hard error" — but "failing" only covers
rejection, not hanging).

**Why it matters.** Retries compound latency on the already-latency-sensitive
home-fetch hard-error path (§4.3), and on a genuinely down dependency
(Azure OpenAI, Supabase), 2 retries × backoff can turn a 2 s failure into a
10-20 s one — directly in the user-facing critical path, in a product where
§4.1 measured 7-27 s as the *already-optimized* number.

**Impact: High**

**Recommended implementation.**
```ts
// lib/llm.ts — bound retries explicitly instead of inheriting the default
const azure = createOpenAI({ baseURL, apiKey });
return azure.chat(deployment, {
  // AI SDK CallSettings surface — forwarded by eve when the model is an
  // explicit LanguageModel instance rather than a bare gateway id string.
});
```
Retries on model calls are best bounded via eve's own retry surface if one is
exposed at the agent level (check `node_modules/eve/docs` for a
`retry`/`maxRetries` agent-definition field in the installed version — not
present in `AgentLimitsDefinition` as of 0.25.2, so this may need an eve
version bump or an explicit ask to the eve team).

For the tool-side dependency calls, add a hard timeout with
`AbortController` — this is unconditionally within your control regardless
of eve's retry surface:
```ts
// lib/partners/get-partners-by-city.ts (home fetch — hard-error path)
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p; // pass ctrl.signal into the Supabase call
  } finally {
    clearTimeout(timer);
  }
}
```
Set the home-fetch timeout tighter than the overall request budget (e.g.
3-5 s) so a hung dependency degrades to the existing hard-error path
(§4.3) instead of hanging the whole turn.

**Estimated impact.** Bounds worst-case single-dependency latency from
"unbounded / provider-default" to a known ceiling (e.g. 5 s home fetch,
3 s per gap-fill city — gap-fill already tolerates individual city failure
via `Promise.allSettled`, §4.3, so it only needs the timeout, not new error
handling).

---

### 3. Duplicate-tool-call detection: already present via the search cache, but not verified for intra-turn dedup

**Problem — mostly solved, one gap.** `lib/partners/search-cache.ts` is a
well-designed 1h/500-entry TTL cache keyed on
`(cityMention, tags, finalRecommendations, intentText)` — exactly the
correction called out in the CLAUDE.md history (§10.11: the old key omitted
`intentText` and caused cross-request collisions). `find_partners.ts` checks
it "BEFORE any I/O" (line 113). This already covers **cross-turn**
duplicate-argument dedup for free. What it does **not** cover: two
**concurrent** identical calls in flight at the same moment (the cache is
read-then-write, not an in-flight promise map), so if the model ever emits
two tool calls with identical arguments in the same step (not expected under
the current 1-tool-per-step design, but not structurally prevented either),
both execute the full pipeline concurrently before either writes the cache.

**Why it matters.** Low probability given the current prompt design (rule:
call `find_partners` once), but the blast radius if it happens is a doubled
Supabase/embedding bill for that one request — worth closing cheaply since
the fix is small.

**Impact: Medium** (the expensive 90% of this recommendation is already
implemented; this closes the remaining edge case)

**Recommended implementation.** Add an in-flight promise map alongside the
value cache so concurrent identical keys await the same execution:
```ts
// lib/partners/search-cache.ts
const inFlight = new Map<string, Promise<unknown>>();

export async function withSearchCache<T>(
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = getCachedSearch<T>(key);
  if (cached) return cached;
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = compute().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  const result = await p;
  setCachedSearch(key, result);
  return result;
}
```
Then replace the manual get/compute/set block in `find_partners.ts`
(lines 126-238) with a single `withSearchCache(cacheKey, async () => {...})`
call.

**Estimated impact.** Closes a narrow but real double-billing edge case;
no latency cost on the common path (still one cache read before any I/O).

---

## Priority 2 — High Impact

### 4. Tool descriptions — already unusually well-tuned; one gap

**Assessment.** This is in noticeably better shape than typical: both tool
descriptions (`find_partners.ts:70-78`, `get_partner_details.ts:10-14`)
explicitly state *when not to call* the tool (`"never during a search"`,
`"do not call extract_city, resolve_partners or build_recommendations
alongside it"` — referencing dead tool names, which is itself flagged as
open issue §10.6). Nine unused eve built-ins are hard-disabled via
`disableTool()` (`bash.ts`, `write_file.ts`, `web_search.ts`, etc.) rather
than merely told-not-to-use, which is the correct pattern — a disabled tool
costs zero schema tokens, an "unused but present" tool still taxes every
call (§4.2, measured: 1,469 tokens/call for the eve built-ins alone).

**Problem.** The `find_partners` description still says *"do not call
extract_city, resolve_partners or build_recommendations alongside it"* —
tools that no longer exist (§5, §10.6 open item). This is presently
harmless (the model can't call a tool that isn't registered) but is exactly
the ambiguity class that caused the §11 fabrication incident, and it costs
schema tokens on every call for a sentence that no longer means anything.

**Impact: Medium**

**Recommended implementation.** One-line edit:
```ts
description:
  "Find and rank sports/wellness partners for a city-based request in ONE call. " +
  "Pass the city exactly as the user wrote it (may be misspelled/abbreviated) plus " +
  "a short description of what they want. Resolves the city, gathers home-city " +
  "partners, fills any gap from nearby cities by similarity, and returns the final " +
  "shortlist with full profiles and an honest coverage disclosure. " +
  "This is the ONLY tool needed for a partner search — call it exactly once per search. " +
  "If it returns needsClarification, ask the user the question it supplies instead of guessing.",
```

**Estimated impact.** ~15-20 tokens/call removed; the larger value is
removing a stale-reference footgun already flagged as open (§10.6), which
compounds with #1 above (nothing currently prevents a confused model from
re-deriving a workaround for a "chain" that no longer exists).

---

### 5. Tool response size — deliberately oversized by an active experiment, not a bug

**Problem.** `DEFAULT_CONFIG` (§7) is currently the wide-context test
profile: `finalRecommendations: 100`, measured **≈41,900 tokens per search**
on top of the ~11k stable prefix — and that's *after* the fix that made
100-profile hydration actually work (§10.8). `PRESETS.PRODUCTION_BASELINE`
(`finalRecommendations: 100` but `minPartners: 12`, `maxCities: 4`,
`similarityThreshold: 0.35`) is a materially cheaper, already-built
alternative sitting one line away
(`export const DEFAULT_CONFIG = PRESETS.PRODUCTION_BASELINE`).

**Why it matters.** Tool results are **not prefix-cached** (confirmed in
CLAUDE.md §7) — every one of those ~42k tokens is billed at full input rate,
every search, no discount. This single dial dwarfs every other cost lever in
this report combined.

**Impact: High** — but explicitly gated by the repo's own instructions
(§7: *"Do not silently 'fix' this — it is a deliberate experiment. Ask
first."*). **This review is not recommending the revert unilaterally** —
it's flagging it as the highest-value decision to make *before* production
sign-off, with the revert already implemented and one line away.

**Recommended implementation (pending your decision).**
1. Run the wide-context profile through `evals/` once with the fixed
   hydration path (§10.8's fix made this measurable for the first time —
   CLAUDE.md flags any pre-fix conclusion about this profile as invalid).
2. Compare quality delta vs. `PRODUCTION_BASELINE` using the eval harness's
   grounding/hallucination/relevance evaluators.
3. If the wide-context profile does not measurably improve answer quality
   over the baseline, revert:
   ```ts
   // agent/config/partner-injection.config.ts
   export const DEFAULT_CONFIG = PRESETS.PRODUCTION_BASELINE;
   ```
4. Independent of the config decision: render only the fields the model
   actually consumes in `renderTier2` (check for any field carried into the
   rendered block — e.g. raw ids, internal warnings — that never appears in
   the final German answer) — this is a smaller, always-safe trim on top of
   whichever profile count wins.

**Estimated savings.** Reverting to `PRODUCTION_BASELINE` alone: from
~42k to a materially smaller per-search payload (the baseline's
`minPartners: 12` means most cities never hit `finalRecommendations: 100`'s
worst case at all — home-city-whole for a median 1-partner city renders ~1
profile, not 100). This is very plausibly a **>10x** reduction in the
tool-result token cost for the median request, without touching the ~11k
stable/cached prefix.

---

### 6. No execution budgets: tool calls, LLM calls, tokens, time, or cost per request

**Problem.** Confirmed absent across the codebase:
- **Max tool calls / LLM calls per turn:** none (see #1 — eve exposes no
  per-turn primitive; only session-wide token totals, currently unset).
- **Max input/output tokens per request:** none set (`agent.ts` has no
  `limits` block at all today).
- **Max execution time per request:** no per-request deadline anywhere in
  `find_partners.ts` or `resolvePartners` — individual stages have their own
  timing *instrumentation* (`timeStage`, §4.3) but nothing that aborts a
  slow overall request.
- **Max cost per request:** none — and CLAUDE.md §9 flags that even the
  *measurement* of cost is currently wrong by ~8× in LangSmith (double-count
  + ignored cache discount), so a cost budget would need to be computed from
  raw token counts × known rates, not from the LangSmith figure, until that
  is fixed.

**Why it matters.** This is the aggregate of #1/#2/#5: without any of these,
a single anomalous request (slow dependency + wide-context config + retry
storm) has no ceiling on latency or spend. The product's own incident
history (§11) shows the team already learned the "efficiency metric without
a work-performed metric" lesson the hard way — the same blind spot applies
to "no metric with any ceiling at all."

**Impact: High**

**Recommended implementation.**
```ts
// agent/agent.ts — the framework-level piece that exists today
export default defineAgent({
  // ...
  limits: {
    maxInputTokensPerSession: 2_000_000,
    maxOutputTokensPerSession: 200_000,
  },
});
```
```ts
// agent/tools/find_partners.ts — a per-request deadline eve doesn't give you
const REQUEST_DEADLINE_MS = 15_000; // above the measured 7-27s p50-p90, below "hung"

async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms deadline`)), ms),
    ),
  ]);
}
```
Wrap the `resolvePartners` + `buildRecommendations` pair in `find_partners`'s
`execute()` with this, and on deadline, return the existing
`needsClarification`-shaped degraded response rather than an unhandled
timeout (eve reports tool failures as stream events per `agent/hooks/
sentry.ts` — confirm a thrown deadline error surfaces there cleanly, or
catch-and-degrade explicitly to stay consistent with the "eve never throws,
it emits events" contract already established for hooks).

For cost: log raw `usage.inputTokens`/`usage.outputTokens` from the model
response next to a hardcoded per-1M rate (Azure list price — do not use
the cached-input assumption in a hard budget check, since the 93% cache
hit rate is an *average*, not a guarantee for any single request) and alert
if a single turn exceeds, e.g., 3× the measured p95.

**Estimated impact.** Converts every "worst case: unbounded" line in this
report into a known number you can put in a incident runbook.

---

## Priority 3 — Optimization

### 7. Caching expensive tool results / external calls — already strong, two gaps

**Assessment.** Already well covered: `search-cache.ts` (1h TTL, whole
search), `find-nearby-cities.ts` caches centroids 24h (§4.3), and the intent
embedding is computed **once** per search and shared across the gap-fill
fan-out (§10, "Also changed" note) rather than once per candidate city. This
is genuinely above-average caching discipline for a first production pass.

**Gaps.**
- **In-flight dedup** — see #3.
- **`city_centroids()` RPC result** (24h cache, §4.3) has no documented
  invalidation hook analogous to `invalidateSearchCache()` for the search
  cache — confirm whether a partner import (which changes centroids) needs
  the same manual-invalidation step called out in §8 ("After partner data
  changes... also call `invalidateSearchCache()`"). If it doesn't already,
  add it to the same post-import checklist.

**Impact: Low** (mop-up on an already-good pattern)

---

### 8. Prompt/context size — the 93% cache-hit rate is the thing to protect, not shrink further

**Assessment.** The ~18KB `instructions.md` is explicitly measured as stable
across requests (§9: 93% cache-hit rate, "the single highest-leverage cost
metric for this agent"). CLAUDE.md §12.11 already states the correct rule:
*"Never inject per-request content into the system prompt."* Nothing in the
current source violates this (confirmed: no timestamp, user name, or
per-request value is interpolated into `instructions.md` or
`002-city-coverage.md`, which is itself a static generated file, regenerated
only via `npm run generate:coverage`).

**Recommendation.** Don't touch the stable prefix. The only real lever here
is #5 (tool *result* size, which is correctly *not* prefix-cached and is
where the actual waste is). Add a monitoring check (already recommended in
CLAUDE.md's own table, §9) rather than a code change:
```ts
// lib/observability.ts (extend the existing resolution-event emitter)
if (cacheReadShare < 0.85) {
  // alert: something started varying the prompt prefix
}
```

**Impact: Low** (already correct; this is a monitoring gap, not a defect)

---

### 9. Prompt simplification without quality loss

**Assessment.** Explicitly *not* recommended to simplify without
re-evaluation: rule #10's redundancy (§5, §12.2) is documented as
deliberately reproducing a specific failure mode twice, on two independent
eval runs. **Do not compress it** per the repo's own instructions.

**What is safe to simplify:** the dead-tool references (#4 above, and the
CLAUDE.md §5 "Known drift" list — `~line 140`, rule #8, follow-up rule #3
still reference `extract_city`/`resolve_partners` in one remaining spot per
CLAUDE.md's own accounting). This is pure token waste with no quality
tradeoff, unlike rule #10.

**Impact: Low-Medium.** A handful of dead references; rewrite to name
`find_partners`, per CLAUDE.md §10.6's own recommendation, and re-run
`evals/` to confirm no quality regression before considering it closed.

---

## Cross-cutting review

### Guardrails (input / LLM / output)

- **Input:** no explicit input guardrail layer (no profanity/injection
  classifier before the message reaches the model). Given the domain (city +
  activity search), the risk surface is narrow, but `intentText`/`tags` flow
  from the model into `similaritySearchPartners` and then into a rendered
  block the model reads back — profile text (`body_markdown`) is already
  correctly treated as "data not instructions" (§14.4, Engineering
  Principles) with prompt-injection resistance stated explicitly in
  `instructions.md` rule #8. That's the one place this really matters (a
  partner profile is externally-writable-ish, effectively untrusted content
  entering the context) and it's already addressed structurally.
- **Output:** the grounding mandate (§5.1, §12.1) plus rule #10's
  fabrication-prevention design (§5) are unusually strong LLM-output
  guardrails for this class of product — this is not a gap.
- **Missing:** no automated post-hoc check that verifies every partner
  *named in the model's final prose* actually appears in that turn's
  `find_partners` result before the message is sent to the user. This is
  currently caught only by the eval harness's grounding evaluator
  (`evals/`), which runs offline, not in the live request path. Consider a
  cheap regex/fuzzy-name check as a last-mile output guardrail — flag
  (Sentry event via the existing hook, don't block) if a capitalized
  multi-word name in the response doesn't match any name in the tool
  result. **Impact: Medium**, since it converts the primary product
  invariant (§1: "Honesty outranks helpfulness") from prompt-only to
  prompt-plus-detection.

### Prompt injection protection

Handled at the architectural level already: `web_search`/`web_fetch`
disabled (§4.2, §6.5 — no live external content ever enters context),
`bash`/`write_file`/`read_file`/`glob`/`grep` disabled (removes the RCE
surface explicitly called out in §4.2), profile text treated as data
(§14.4). This is genuinely solid for the current architecture. The one open
edge: `cityMention`/`intentText`/`tags` are free-text model outputs derived
from user input, echoed back into `resolveCityFuzzy`/`similaritySearchPartners`
— these are parameterized RPC calls (not string-built SQL), so this is a
data-flow question, not a SQL-injection one; no action needed unless a raw
SQL path is ever added (`supabase-postgres-best-practices` skill covers this
if/when it is).

### Tool security and authorization

Service-role Supabase key (bypasses RLS, §6/§12.6) is by design — correct
call for a single-tenant internal agent, explicitly documented. Six-table
anonymous-write vulnerability already remediated (§6, migration
`lock_down_anonymous_writes`). No user-scoped authorization layer exists
because there's no per-user data boundary in this product (public directory
data only) — not a gap for the current scope.

### Sensitive data handling

Rule #6's contact-data inversion (§5) is a deliberate, well-reasoned product
decision, not an oversight — documented at length with the specific
regression it fixed. `email`/`phone` never enter `PartnerLite` (§4.4, §12.4)
— single canonical path maintained. Sentry hook explicitly forwards no user
text/PII (`agent/hooks/sentry.ts` docstring, confirmed in source). This
category is in good shape.

### Error handling and fallback behavior

Strong: home-fetch-hard/nearby-soft asymmetry (§4.3, §12.8), `Promise.
allSettled` gap-fill fan-out, embedding-down degrade path (though #10.3
notes it currently degrades to *zero usable partners* due to the similarity
floor bug — that's an open retrieval-quality issue, not an error-handling
architecture issue), and the "eve never throws, always emits events" +
`guard()`-wrapped hook pattern (`agent/hooks/sentry.ts`) is a genuinely
good pattern for an agent framework where exceptions don't propagate
normally. The one gap: no per-request **timeout** anywhere (see #2, #6) —
today's fallback logic activates on *rejection*, never on *hanging*.

### Monitoring, tracing, and observability

Already unusually mature for a pre-launch agent: Sentry six-class failure
taxonomy with stable fingerprints, LangSmith OTel wiring (with the known
double-trace-row simplification documented as deferred, §9), and — notably
— CLAUDE.md's own §9 table of health metrics already encodes the exact
lesson this whole review is built on: *pair every efficiency signal with a
work-performed signal.* `profiles hydrated ÷ partners shortlisted` and
`cities in the centroid map` are excellent, unusual metrics to have
pre-defined. Nothing to add here beyond the cache-hit-rate active alert
noted in #8 and the cost-budget alert in #6 — both are extensions of the
existing table, not new architecture.

### Rate limiting and abuse prevention

**Gap.** No rate limiting found anywhere — not per-user, per-IP, or
per-session. This product currently has "no auth" on the dev console
(§3: "no auth"), which is fine for internal dev use but is a real gap if
this agent (or its Next.js dev console) is what actually gets deployed
publicly. **Impact: High if internet-facing, N/A if internal-only** — this
is a scope question for you: is production deployment behind Sportnavi's
own auth/gateway, or is this console itself the production surface? If the
latter, rate limiting (per-session request count, per-IP burst limit) is a
Priority-1-equivalent blocker, not a Priority-3 nice-to-have — flagging it
here rather than silently defaulting to "internal only."

### Production readiness and deployment

- `.env.local` (not `.env`) is the only supported env file, must be loaded
  first via `lib/load-env.ts` (§8, §12.9) — confirm the actual production
  deploy target (eve hosted? Vercel? Docker?) loads env the same way; the
  Windows dev-host module-resolution shim (§8) is dev-only and should be
  verified as a no-op (or absent, if truly Windows-dev-only) on whatever
  production OS is targeted.
- LangSmith key currently sits in `.mcp.json` on disk (§10.7, open, low
  urgency since gitignored) — rotate before/at production cutover as a
  hygiene step, per the repo's own note.
- No CI-run eval gate found (`evals/` exists and has a calibration harness,
  but nothing in `package.json`'s scripts wires it into a pre-deploy check).
  **Recommendation:** add `npx tsx evals/calibrate-evaluators.ts` +
  the eval run itself as a required step before any deploy that touches
  `instructions.md`, `partner-injection.config.ts`, or `agent/tools/*` —
  exactly the files this whole report proposes changing. **Impact: Medium**,
  closes the loop between "we have an eval harness" and "the eval harness
  actually gates production changes."

---

## Prioritized Production-Readiness Checklist

Ordered by impact on cost, performance, security, and reliability — highest
first.

1. **[Cost/Reliability — CRITICAL] Decide the config profile (#5).** The
   wide-context experiment (`finalRecommendations: 100`, no distance/city
   caps that matter) is ~42k tokens/search, uncached, and is a config
   toggle away from a known-cheaper baseline. This single decision has more
   cost impact than every other item combined. Run `evals/` on both, decide,
   record the delta.
2. **[Reliability — CRITICAL] Add per-request timeouts (#2, #6).** No
   timeout exists on the home-city fetch (hard-error path) or the overall
   `find_partners` execution. A hung dependency currently has no ceiling.
3. **[Cost/Reliability — CRITICAL] Set session-level token limits in
   `agent.ts` (#1, #6).** `AgentLimitsDefinition` is available today and
   unset; the framework default (40M input tokens/session) is not a
   meaningful ceiling for this product.
4. **[Security — HIGH, scope-dependent] Rate limiting.** Confirm the
   production surface (dev console vs. behind an existing gateway) and add
   rate limiting if this console is internet-facing. This is a blocking
   question, not an optional hardening step, if the answer is "yes."
5. **[Reliability — HIGH] Gate deploys on the eval harness.** `evals/`
   exists with a calibration step but isn't wired into any deploy/CI gate.
   Every item in this list changes files the eval harness is designed to
   catch regressions in.
6. **[Cost/Quality — MEDIUM] Close the duplicate-tool-call edge case
   (#3).** Small fix (in-flight promise map) on top of an already-good
   cache; closes concurrent double-billing.
7. **[Quality/Cost — MEDIUM] Remove dead tool-name references
   (#4, #9).** `find_partners`'s own description and three spots in
   `instructions.md` still name deleted tools — the exact ambiguity class
   that caused the §11 fabrication incident. Already flagged open in
   CLAUDE.md §10.6; low effort, re-run evals after.
8. **[Reliability — MEDIUM] Add a last-mile output grounding check.**
   Detects a model-invented partner name at request time rather than only
   in offline evals — a live tripwire for the product's core invariant.
9. **[Ops — LOW] Rotate the LangSmith key currently on disk in
   `.mcp.json`.** Already gitignored/contained; do this as part of the
   production cutover checklist rather than urgently.
10. **[Ops — LOW] Confirm `city_centroids()`'s 24h cache has the same
    post-import invalidation story as the search cache.** Small
    documentation/consistency gap, not a live bug.
11. **[Ops — LOW] Add the cache-hit-rate and cost-ceiling alerts to
    existing monitoring (#6, #8).** Extends a table CLAUDE.md already
    defines; no new architecture needed.

**What NOT to do**, per the repo's own hard-won lessons (§11, §13
"Explicitly not recommended"): don't compress rule #10, don't re-introduce
tool orchestration/chaining to "optimize" step count, don't add a curator
subagent, don't treat LangSmith's cost figure as ground truth (§9 — it's
~8× inflated by design, use it as a relative regression signal only).
