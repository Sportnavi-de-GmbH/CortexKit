# Navio agent monitoring — tracing, Supabase persistence, dashboard

**Date:** 2026-09-14 · **Branch:** `v3-partner-retrieval` · **Status:** approved design, not implemented

## 1. Goal

A step-by-step observability system for the Navio widget: every agent execution (a FAQ turn or a
Partner turn) becomes a **trace** with ordered, nested **steps**, persisted in a **new, dedicated
Supabase project**, and browsable in a **password-protected dashboard** at `/monitoring` inside the
widget app. Both technical and non-technical users must be able to open any execution and answer:

> What did the user ask? → What did the agent do? → What happened at every step? → Which tools were
> used, with which inputs/outputs? → How long and how much did it cost? → What was the final answer?
> → How did the user react?

## 2. Scope and non-goals

**In scope**

- FAQ agent turns (`kb-agent-langsmith-starter`, eve, `/eve/v1/*`).
- Partner turns served by **V3** (`SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3`)
  through the widget's adapter `POST /api/partner/workflow` → `${PARTNER_AGENT_HOST}/api/workflow`.
- Persistence of every 👍/👎 vote (both surfaces) with its trace.
- Dashboard: overview + trace list, trace detail with timeline, session view.
- One **additive** change inside V3: surface token usage per model call (approved by the owner),
  so partner cost can be computed. Nothing else in V3 changes.

**Out of scope / unchanged**

- Langfuse stays exactly as it is (exporter, hooks, scores, queues, dashboards). Supabase is an
  additional layer, not a replacement.
- The eve-protocol partner agents (convex / supabase / v2) are not instrumented. `PARTNER_AGENT_KIND
  = "eve"` traces nothing on the partner side (the FAQ side still traces).
- No change to prompts, recommendation logic, tool behaviour, routing, auth of existing endpoints,
  or widget visuals.
- V3 runs started from V3's own dev UI or CLI are **not** captured (only widget-originated runs).

## 3. Decisions taken in the interview

| Question | Decision |
|---|---|
| Which agent | Whole widget: FAQ + Partner, Partner = V3 |
| Relation to Langfuse | Add alongside, leave untouched |
| Dashboard home | New `/monitoring` route in the widget app |
| Dashboard auth | Shared password from env var, signed httpOnly cookie |
| Partner capture point | Widget adapter route (V3 already returns its full `WorkflowTrace`) |
| Database | New separate Supabase project; owner pastes URL + service-role key into `.env.local` |
| Content policy | Store full visitor text and answers, always |
| Partner cost | Approved: V3 surfaces `usage`; the widget prices it |

**Findings that shaped the design**

1. Partner 👍/👎 on V3 answers are currently lost: `/api/feedback` forwards `surface: "partner"`
   votes to `${PARTNER_AGENT_HOST}/api/feedback`, which V3 does not have → 502, swallowed by design.
2. The widget does not send `sessionId`/`turnId` to `/api/partner/workflow` (body is
   `{message, resume}`), so a V3 trace cannot be linked to later feedback without adding them.
3. V3's `lib/llm-port.ts` discards `usage` from all four AI SDK calls, so partner cost is
   unavailable without the additive V3 change.

## 4. Data model (Supabase, new project, schema `public`)

All tables have RLS **enabled with no policies** — service-role only. The browser never holds a key;
the dashboard reads through server route handlers.

### `agent_sessions`
| column | type | notes |
|---|---|---|
| `id` | text PK | the widget's session id (eve session id for FAQ, client-generated uuid for V3) |
| `agent` | text | `faq` \| `partner` |
| `first_seen_at`, `last_seen_at` | timestamptz | |
| `turn_count` | int | maintained by the writer |
| `origin` | text | request origin, nullable |
| `metadata` | jsonb | |

### `traces`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | text FK → agent_sessions | |
| `agent` | text | `faq` \| `partner` |
| `agent_version` | text | widget git sha (`VERCEL_GIT_COMMIT_SHA` or local `git rev-parse`) |
| `turn_id` | text | the widget's `turn_N` (feedback key) |
| `turn_index` | int | N |
| `status` | text | `running` \| `completed` \| `needs_clarification` \| `partial` \| `failed` |
| `started_at`, `ended_at` | timestamptz | |
| `duration_ms` | int | |
| `first_token_ms` | int | FAQ only, nullable |
| `user_input` | text | |
| `final_output` | text | |
| `prompt_version_id` | uuid FK → prompt_versions | nullable (partner: the answer prompt is per-task, stored on the step) |
| `models` | text[] | |
| `tools_called` | text[] | |
| `step_count`, `tool_call_count`, `error_count`, `warning_count` | int | denormalised |
| `tokens_input`, `tokens_output`, `tokens_cached` | int | nullable |
| `cost_estimate_usd` | numeric(12,6) | nullable |
| `feedback_thumb` | text | latest vote: `up` \| `down` \| null |
| `metadata` | jsonb | V3: `run_id`, `config`, `deferred`, `pending`, `clarification`; FAQ: `langfuse_session_id`, `channel`, `env` |

Indexes: `(started_at desc)`, `(agent, started_at desc)`, `(session_id, turn_index)`,
`(status)`, `(feedback_thumb)`, unique `(session_id, turn_id)`.

### `trace_steps`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `trace_id` | uuid FK → traces (cascade) | |
| `parent_step_id` | uuid FK → trace_steps | null = top level; used for V3 task groups |
| `sequence` | int | order within the parent |
| `kind` | text | `request` \| `llm` \| `tool` \| `retrieval` \| `transform` \| `response` \| `error` \| `group` |
| `name` | text | stable id, e.g. `detect-city`, `generate-answer` |
| `title` | text | human, e.g. "Detect city" |
| `purpose` | text | one plain sentence: why this step happens |
| `status` | text | `ok` \| `warning` \| `error` \| `skipped` |
| `started_at` | timestamptz | nullable (V3 stages report duration only; started_at derived when possible) |
| `duration_ms` | int | |
| `input`, `output` | jsonb | |
| `tool_name` | text | nullable |
| `model` | text | nullable |
| `tokens_input`, `tokens_output`, `tokens_cached` | int | nullable |
| `cost_estimate_usd` | numeric(12,6) | nullable |
| `warnings` | text[] | |
| `error` | jsonb | `{message, type?}` |
| `metadata` | jsonb | V3: `config`, `counts`, `filters`; FAQ: prompt fingerprint etc. |

Index: `(trace_id, parent_step_id, sequence)`.

### `feedback` (append-only)
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `trace_id` | uuid FK → traces | nullable until linked |
| `session_id`, `turn_id` | text | always present |
| `agent` | text | from `surface` |
| `thumb` | text | `up` \| `down` \| null (= retraction) |
| `reason` | text | nullable |
| `comment` | text | nullable |
| `epoch` | int | |
| `agent_version` | text | nullable |
| `created_at` | timestamptz | |
| `metadata` | jsonb | |

Every vote, flip, retraction and comment is a new row. The trace's current verdict is the latest row
(`traces.feedback_thumb` is a denormalised copy for filtering).

### `errors`
`id`, `trace_id`, `step_id` (nullable), `level` (`error` \| `warning`), `type` (classified via
`FAILURE_PATTERNS` from `lib/langfuse.ts`; `unclassified` otherwise), `message`, `created_at`,
`metadata`. Index `(created_at desc)`, `(trace_id)`.

### `events`
`id`, `type`, `trace_id` (nullable), `session_id` (nullable), `payload` jsonb, `created_at`.
The monitoring system's own log: `trace.write_failed`, `feedback.unlinked`,
`feedback.partner_forward_failed`, `partner.upstream_error`, `trace.abandoned`.

### `prompt_versions`
`id` uuid PK, `agent`, `sha256` (unique), `size_chars`, `approx_tokens`, `sections` text[],
`content` text, `first_seen_at`. Each distinct system prompt is stored **once**; traces/steps reference
it by id.

### Step mapping

**FAQ** (top level, in order)

| seq | kind | name | title | purpose |
|---|---|---|---|---|
| 1 | request | `request-received` | Request received | The visitor's message reached the FAQ agent. |
| 2 | transform | `load-knowledge-base` | Load knowledge base | The agent's curated Sportnavi knowledge base (version `<digest>`) is placed in context; no retrieval happens. |
| 3 | llm | `generate-answer` | Generate answer | One model call writes the answer from the question and the knowledge base. |
| 4 | response | `answer-delivered` | Answer delivered | The finished answer was streamed to the widget. |
| — | error | `failure` | Failure | Appended on `step.failed` / `turn.failed` / `session.failed`. |

**Partner (V3)**

| seq | kind | name | title | purpose |
|---|---|---|---|---|
| 1 | request | `request-received` | Request received | The visitor's message reached the partner workflow. |
| 2 | llm | `decompose` | Split into search tasks | One model call splits the message into independent searches (different activity or place). |
| 3..n | group | `task:<id>` | Task k — `<label>` | One independent search, run in parallel with its siblings. Children below. |
| — | response | `answer-composed` | Answer composed | The per-task answers were combined into the reply shown to the visitor. |

Children of each task group, in order: `detect-city` (retrieval), `reformulate` (llm),
`nearby-cities` (retrieval), `search` (tool, `tool_name = similarity_search`, input = retrieval query
+ cities, output = per-city results + candidates), `rerank` (transform), `respond` (llm, output =
answer + recommendations). Stage `warnings`, `error`, `config`, `counts`, `filters` are copied
verbatim. Task status `needs_clarification` → the group step is `warning` with the clarification in
`output`. Deferred/pending tasks go to `traces.metadata`.

## 5. Capture

New module in the widget app: `kb-agent-langsmith-starter/lib/monitoring/`

| file | responsibility |
|---|---|
| `types.ts` | `TraceDraft`, `StepDraft`, `FeedbackDraft` — the in-memory shapes both agents produce |
| `store.ts` | Supabase writer (`@supabase/supabase-js`, service-role). No creds ⇒ no-op. Never throws. One batched RPC per write (`monitoring_write_trace(jsonb)`) that upserts trace + steps + errors + prompt version + session in one transaction. One retry; then `console.error` shape-only and an in-memory `events` entry flushed with the next successful write. |
| `pricing.ts` | re-export of `estimateCostUsd` from `lib/langfuse.ts` (one price table for both agents) |
| `faq-mapper.ts` | pure: eve hook events + captured prompt → `TraceDraft` |
| `v3-mapper.ts` | pure: `WorkflowTrace` (+ session/turn ids) → `TraceDraft` |
| `describe.ts` | step `name` → `{title, purpose}` plain-language table (the "why") |
| `feedback.ts` | `recordFeedback(parsed)` → resolve trace by `(session_id, turn_id)`, insert row, update `traces.feedback_thumb` |
| `env.ts` | `MONITORING_SUPABASE_URL`, `MONITORING_SUPABASE_SERVICE_ROLE_KEY`, `isMonitoringEnabled()` |

### FAQ path — `agent/hooks/monitoring.ts`
A sibling of `agent/hooks/langfuse.ts`, every handler wrapped in the same `guard()`.

| event | action |
|---|---|
| `message.received` | create `TraceDraft` (session, turn, input, started_at); **insert `traces` row with `status = running`**; upsert `agent_sessions` |
| `step.started` (via the existing `systemPromptStore` populated by `instrumentation.ts`) | sha256 the prompt → `prompt_versions`; "Load knowledge base" step |
| `step.completed` | "Generate answer" step: model, usage, duration, cost |
| `action.result` | `tool` step (none today; wired so a future tool is traced without code change) |
| `message.completed` / `turn.completed` | final output, "Answer delivered", status, totals → **update** the trace row |
| `step.failed` / `turn.failed` / `session.failed` | `error` step + `errors` row, classified; trace status `failed` |

Serverless: a turn spans several Vercel invocations (CLAUDE.md serverless traps), so the draft is
not kept only in memory — the `running` row is written first and steps are inserted as they complete,
keyed by `(session_id, turn_id)`. The dashboard shows a trace `running` for > 5 min as **abandoned**
(and a scheduled `npm run monitoring:reconcile` marks it so and logs `trace.abandoned`).

### Partner path — `lib/partner-workflow.ts`
After the upstream response is received and before it is returned: parse the `WorkflowTrace`,
`v3Mapper()`, `store.writeTrace()` — fire-and-forget with a 5 s cap so the visitor's answer is never
delayed. An upstream non-2xx is recorded as a `failed` trace with an `errors` row and a
`partner.upstream_error` event.

Widget change (additive): `useWorkflowAgent` includes `sessionId` and `turnId` in the POST body. The
adapter reads them and **strips them before forwarding** so V3's request schema is untouched.

### V3 change (approved, additive)
- `LlmPort` methods return `usage?: { input: number; output: number; cached?: number }` alongside
  their current result (`createAzureLlmPort` reads `result.usage` from `generateObject` /
  `generateText`; the test fake returns none).
- `StageRecord.usage?` and `StageRecord.model?` populated by stages 0, 1, 2, 6; `TaskRun.usage?`
  and `WorkflowTrace.usage?` are sums.
- No behaviour change; existing V3 tests and dev UI unaffected.

### Invariants (mirroring the Langfuse layer)
1. No credentials ⇒ every monitoring surface is a silent no-op; a fresh clone runs credential-free.
2. Monitoring code never throws into the agent or a route; failures are logged shape-only.
3. A monitoring write never delays or fails a visitor's answer.
4. The browser never sees a Supabase key; all writes and reads are server-side.
5. Full visitor text is stored (owner decision) — no truncation, no redaction.

## 6. Feedback

`POST /api/feedback` (widget) gains one call after validation and rate limiting, before any
Langfuse logic: `monitoring.recordFeedback(parsed)` — for **both** surfaces, never throws.

- Resolve `trace_id` by `(session_id, turn_id)`. Not found (vote beat the trace write) → the row is
  stored with `trace_id = null` plus the ids; the trace writer back-links on completion, and
  `npm run monitoring:reconcile` links any leftovers.
- `thumb: null` is stored as a retraction row.
- Existing behaviour after that call is unchanged: FAQ → Langfuse scores; partner →
  `forwardToPartner` (still fails against V3; the failure is now an `events` row
  `feedback.partner_forward_failed` instead of only a console line).

Net effect: partner votes on V3 answers are persisted for the first time; FAQ votes land in both
systems.

## 7. Dashboard

Route group `app/monitoring/` in the widget app; data API under `app/api/monitoring/traces*`,
`.../stats`, `.../sessions/*` (the existing `app/api/monitoring/alerts/*` relay is untouched).

### Auth
- `MONITORING_PASSWORD` (required to enable) and `MONITORING_COOKIE_SECRET` (HMAC key).
- `app/monitoring/login` → `POST /api/monitoring/auth`: constant-time compare → signed httpOnly,
  `SameSite=Lax`, `Secure` in production cookie, 7-day expiry.
- `proxy.ts` (Next 15 middleware) guards `/monitoring/*` and `/api/monitoring/traces*|stats|sessions*`.
- Password unset ⇒ those routes return **404** (never an accidentally open dashboard).
- 5 failed logins per IP per 15 min → 429 (per instance; Firewall rule for production).

### Data API (server-only, service-role client)
- `GET /api/monitoring/traces?agent&status&thumb&q&from&to&cursor&limit=50`
- `GET /api/monitoring/traces/:id` → trace + nested steps (tree) + errors + feedback history +
  prompt version (content on demand via `?prompt=1`)
- `GET /api/monitoring/stats?range=24h|7d|30d` → executions, success rate, avg/p95 latency, total
  cost, 👍 rate, per-day series by agent, latest errors
- `GET /api/monitoring/sessions/:id` → turns of one conversation

### Screens
1. **Overview** — KPI tiles; executions-per-day bars split by agent; latest errors; **trace list**
   (time · agent badge · question · status pill · duration · cost · steps/tools · 👍/👎) with filters
   (agent, status, feedback, search, date). Click → detail.
2. **Trace detail** — header card ("🟢 Completed · 4.8 s · 7 steps · 2 tool calls · $0.0021 · 👍");
   conversation frame (*What the user asked* / *What Navio answered*); **timeline**: vertical rail,
   one card per step — kind icon, human title, one-sentence purpose, proportional duration bar,
   status. V3 task groups render as side-by-side lanes under the decompose step. Each card expands
   to Input / Output (pretty JSON with copy; tabular views for candidate and ranking lists),
   Config, Warnings/Errors, and a **Technical details** disclosure (raw ids, model, tokens,
   metadata). Sticky right rail: prompt version (fingerprint, open full prompt), models, tokens,
   cost, session link, feedback history with comments, Langfuse session id if present.
   Keyboard: `j`/`k` next/previous step, `e` expand all, `c` collapse all. Long traces: steps are
   collapsed by default, groups are collapsible, large JSON is virtualised/truncated with
   "show all".
3. **Session view** — all turns of one conversation as a thread, each linking to its trace.

### Design language
`docs/design/WIDGET-DESIGN-GUIDELINES.md`: Outfit + Inter; brand-green = success/AI; orange =
warning/human; a neutral red used only inside the dashboard for errors. Light/dark. Existing
Tailwind + lucide; no new UI framework. Plain-language labels first, technical detail behind
disclosures.

## 8. Configuration

Widget `.env.local` / Vercel (`navio-widget`):

| variable | required | notes |
|---|---|---|
| `MONITORING_SUPABASE_URL` | to enable | new monitoring project |
| `MONITORING_SUPABASE_SERVICE_ROLE_KEY` | to enable | server-only, sensitive |
| `MONITORING_PASSWORD` | for the dashboard | unset ⇒ dashboard 404 |
| `MONITORING_COOKIE_SECRET` | for the dashboard | ≥ 32 random bytes |
| `MONITORING_ENVIRONMENT` | optional | defaults to `VERCEL_ENV` then `NODE_ENV`; stored in `traces.metadata.env` |

Migrations live in `kb-agent-langsmith-starter/supabase/migrations/*.sql` (source of truth) and are
applied with the Supabase MCP / SQL editor. Secrets are never committed; `.env.local.example` gains
the variable names only.

## 9. Testing and validation

- **Unit (vitest, widget):** `faq-mapper` from a recorded event journal (success + failure);
  `v3-mapper` from real `WorkflowTrace` fixtures (single task, three parallel tasks,
  `needs_clarification`, `failed`); `describe` covers every step name; `pricing`; auth cookie
  sign/verify; `store` no-creds no-op and "never throws" with a failing client; `recordFeedback`
  linked / unlinked / retraction.
- **Unit (vitest, V3):** `usage` surfaced and summed; existing tests unchanged.
- **Integration:** `scripts/monitoring-verify.ts` (`npm run monitoring:verify`) sends one FAQ and
  one partner question through the running widget, casts a vote on each, then reads Supabase back and
  asserts: trace created automatically · every expected step present · order correct · inputs and
  outputs on each step · tool step visible with response · error captured (run with
  `--expect-failure`) · durations and cost > 0 · final output linked · feedback linked to the right
  trace · session row updated.
- **Regression:** `npm test` + `npm run typecheck` green in the widget and in V3; `npm run
  langfuse:verify` unchanged.
- **Browser:** `browse` skill pass on `/monitoring` — login, list, filters, detail, expand/collapse,
  a 3-task V3 trace, a failed trace, dark mode, 400 px width.

## 10. Implementation order

1. Supabase migration + `store.ts` + `types.ts` + `env.ts` (no-op without creds).
2. V3 usage surfacing (additive) + tests.
3. `v3-mapper` + adapter wiring + widget `sessionId/turnId` + tests.
4. `faq-mapper` + `agent/hooks/monitoring.ts` + tests.
5. Feedback persistence in `/api/feedback` + tests.
6. Dashboard auth + data API.
7. Dashboard UI (overview → detail → session).
8. `monitoring:verify` + `monitoring:reconcile` scripts; browser pass; docs (`docs/MONITORING.md`,
   CLAUDE.md pointer).
