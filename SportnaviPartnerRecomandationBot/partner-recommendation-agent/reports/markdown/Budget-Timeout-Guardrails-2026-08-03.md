# Budget, Timeout, and Guardrail Hardening — 2026-08-03

Implements the six production-readiness gaps identified in
[`Production-Readiness-Review-2026-08-03.md`](Production-Readiness-Review-2026-08-03.md):
no ceiling on model steps/tool calls, stale/unclear tool descriptions, no
request-level budget, no live output guardrail, no dependency timeouts, and
no explicit token ceiling.

**Framework constraint that shaped every decision below:** this agent runs
on eve (`0.25.2`), not a bare Vercel AI SDK loop. eve exposes no
`stopWhen`/`maxSteps`/per-turn tool-call-count API, and its hooks
(`defineHook`) are **observe-only** — they cannot block a tool call, abort a
turn, or edit an outgoing message. Every mechanism here works within that
constraint rather than around it; see "Remaining risks" for what that rules
out entirely.

---

## What changed

### 1. Per-turn execution budget — `lib/request-budget.ts` (new)

A TTL-cached, per-`session.id` counter (`lib/cache.ts`'s existing
`createTtlCache`, same pattern `search-cache.ts` uses) tracking tool calls,
model steps, accumulated tokens, an estimated cost, and wall-clock elapsed
since the turn started. `recordToolCallStart(sessionId)` is the enforcement
call — it increments the tool-call counter and rejects if any limit is
already breached:

| Limit | Default | Rationale |
|---|---|---|
| `maxToolCalls` | 3 | Normal path is exactly 1 |
| `maxModelSteps` | 4 | Normal path is exactly 2 (search) or 1 (chat) |
| `maxWallClockMs` | 20,000 | Measured p50-p90 was 7-27s |
| `maxTokensPerTurn` | 80,000 | Covers the wide-context config's ~42k/search with headroom |
| `maxEstimatedCostUsd` | 0.15 | From raw usage × Azure list price — **not** LangSmith's cost figure, which CLAUDE.md §9 documents as ~8x wrong (double-count + ignored cache discount) |

`agent/hooks/budget.ts` (new) feeds this module from eve's event stream —
`message.received` resets the window, `step.completed` accumulates
per-step usage, `turn.completed`/`turn.failed`/`session.failed` clear it.
It mirrors the existing `agent/hooks/sentry.ts`/`agent/hooks/langsmith.ts`
shape exactly (`guard()`-wrapped handlers, never throws, exports
`handlersFor()` for direct testing).

### 2. Enforcement wired into the two tools

`agent/tools/find_partners.ts` and `agent/tools/get_partner_details.ts` now
accept the `ctx` parameter eve's `defineTool` already provides (previously
ignored) and call `recordToolCallStart(ctx.session.id)` as the first thing
in `execute()`. On rejection, `find_partners` degrades to its **existing**
`needsClarification` contract (no new response shape — the model already
knows how to surface that verbatim); `get_partner_details` degrades to
`null`, its existing "unknown id" contract.

This is the actual stop-doing-work mechanism, not the hook — hooks can only
observe.

### 3. Wall-clock timeouts — `lib/timeout.ts` (new) + threaded `AbortSignal`s

`withTimeout(promise, ms, label)` races a promise against a deadline;
`timeoutSignal(ms)` wraps `AbortSignal.timeout(ms)`.

- `find_partners.ts` wraps its entire resolve+hydrate pipeline in a 15s
  outer deadline, degrading to `needsClarification` on timeout.
- `get_partner_details.ts` wraps its single lookup in a 6s deadline,
  degrading to `null`.
- Every external call now carries a per-stage `AbortSignal`, threaded
  through the existing DI seams (`deps` objects where present, a new
  trailing `opts`/positional param where not) so Supabase actually cancels
  the request rather than eve's timeout merely abandoning the promise:

  | Stage | File | Timeout |
  |---|---|---|
  | Home-city fetch (hard-error path) | `get-partners-by-city.ts` | 5s |
  | Nearby-city/centroid RPC | `find-nearby-cities.ts` | 3s |
  | Per-candidate-city similarity search (each, concurrent) | `similarity-search-partners.ts` | 4s |
  | Shared intent embedding | `embeddings.ts` | 4s |
  | Profile hydration (batched) | `build-recommendations.ts` | 5s |
  | Single partner lookup | `get-partner-details.ts` | 6s |

  Per-stage signals (not one shared per-request signal) so a slow home
  fetch can't eat into the nearby-cities budget, and gap-fill's existing
  `Promise.allSettled` resilience (one slow city doesn't block the others)
  is preserved rather than defeated by a single shared deadline.

  `lib/embeddings.ts`'s `embedText` now accepts `opts?: { signal }`,
  forwarded into the raw `fetch()` (Azure path) and into the AI SDK's
  `embed({ abortSignal })` (gateway path) — both already supported this,
  just weren't wired.

### 4. Live output grounding tripwire — `lib/partners/grounding-check.ts` (new)

**Alert-only, not a block** — eve hooks can't edit or withhold a reply, so
this cannot prevent a fabrication; it can only surface one *during* the
request instead of only in an offline `evals/` run.

`checkGrounding(replyText, knownNames)` extracts Title-Case, business-name-shaped
spans from the reply and flags any that don't match a name this turn's
`find_partners` actually returned. `find_partners.ts` records the
shortlist's names into `lib/request-budget.ts` on success
(`recordKnownNames`); `agent/hooks/sentry.ts` gained a `message.completed`
handler that runs the check and, on a flag, calls `sentry.captureMessage`
with the existing `handlersFor`/`captureFailure` conventions — a new
`fabrication` `FailureClass` was added to `lib/sentry-agent.ts` alongside
the existing six.

**Privacy:** the suspect name text itself is never sent to Sentry, only a
count — consistent with `agent/hooks/sentry.ts`'s existing "no partner
names forwarded" rule. Verified by a unit test asserting the captured
payload never contains the fabricated name string.

Turns with no partner search this turn (`knownNames` empty) are skipped
entirely rather than flagging every city name and pleasantry in ordinary
conversation.

### 5. Explicit session token ceiling — `agent/agent.ts`

```ts
limits: {
  maxInputTokensPerSession: 3_000_000,
  maxOutputTokensPerSession: 300_000,
}
```

eve's own default (`maxInputTokensPerSession` unset → platform default of
40,000,000/session) was not a meaningful ceiling. This is a **multi-turn
conversation** budget, not a per-request one — the per-request budget is
§1/§2 above. 3M tokens covers roughly 70 searches at the current
wide-context config's measured ~42k tokens/search.

### 6. Tool description cleanup

`find_partners.ts`'s description dropped its reference to three tools that
no longer exist (`extract_city`, `resolve_partners`,
`build_recommendations`) — the exact class of ambiguity CLAUDE.md §11
identifies as the root cause of the earlier fabrication incident — in favor
of a direct positive statement ("call it exactly once per search").
`get_partner_details.ts`'s description now states its concrete return shape
(`{ partnerId, name, city, llmProfile }` or `null`) so the model has an
explicit contract instead of an implicit one. `instructions.md` was
checked and needed no change — its one historical mention of the old tool
names is already past-tense and accurate (confirmed by CLAUDE.md §10.6).

---

## Expected impact

| Dimension | Before | After |
|---|---|---|
| Worst-case tool calls/model steps per turn | Unbounded | 3 tool calls / 4 model steps (hard) |
| Worst-case single-search latency | Unbounded (no timeout existed anywhere) | 15s hard ceiling, with per-stage sub-timeouts inside it |
| Worst-case single-dependency hang | Unbounded | 3-6s per stage, actually cancelled via `AbortSignal` |
| Fabrication detection | Offline only (`evals/`, after the fact) | Live, alert-only, within the request |
| Session token ceiling | Implicit 40M (eve default) | Explicit 3M, documented |
| Tool-description ambiguity | Referenced 3 dead tool names | Clean, positive, single-call contract |
| Cost visibility | None per-request | Estimated per-turn (list price, conservative) |

**Reliability** is the dimension most improved: every "could hang/loop
forever" path identified in the prior review now has a concrete number
attached to it. **Security/trust** gains a live tripwire for the product's
core "never invent a partner" invariant instead of relying solely on
prompt discipline plus an offline eval. **Cost** gains an estimate and a
documented ceiling, though see the risk below about what that ceiling
cannot do mid-flight.

---

## Remaining risks before production deployment

These are real eve platform limitations surfaced by this work, not gaps in
the implementation:

- **No way to reduce `maxRetries` on the main chat model call itself.**
  That knob exists in the raw AI SDK's `generateText`/`streamText`, but
  isn't forwarded through eve's public `agent.ts` API as of `0.25.2`
  (confirmed against `node_modules/eve/dist/src/shared/agent-definition.d.ts`
  — `AgentLimitsDefinition` only exposes session token totals). Retries on
  the Azure call are still whatever eve's internal default is. This is an
  upstream eve gap; worth raising with the eve team, not fixable from this
  repo today.
- **The grounding guardrail is alert-only, not blocking.** A genuinely
  hallucinated reply still reaches the user — it's caught (loudly, in
  Sentry, tagged `fabrication`) rather than prevented. The heuristic itself
  (Title-Case span matching) will also both under- and over-flag; it is a
  tripwire, not a classifier.
- **Per-request cost is estimated, not enforced in real time.** There is no
  way to abort a model call that's already in flight from eve's public
  surface, so the cost budget can only block the *next* tool call/step —
  never the one currently running. A single unusually expensive step still
  completes.
- **The wide-context config profile is unchanged.**
  `DEFAULT_CONFIG.finalRecommendations: 100` (~42k tokens/search,
  uncached) is untouched by this work — it remains the prior review's
  still-open item 5, a deliberate experiment CLAUDE.md §7 says not to
  revert without asking first.
- **The budget/timeout/grounding tools have not been exercised live.**
  Every new module has unit-test coverage (`npm test`, 270 tests passing,
  `npm run typecheck` clean), but the manual live checks described in the
  approved plan — lowering `maxWallClockMs`/`maxToolCalls` to an
  unreachable value via `npm run dev:ui` and confirming the graceful
  degrade path fires end-to-end, plus `npx tsx
  scripts/verify-review-fixes.ts` to confirm the `.abortSignal(...)`
  additions didn't regress the §10.8-10.10 live fixes — have not been run
  in this session and should happen before deploy.
