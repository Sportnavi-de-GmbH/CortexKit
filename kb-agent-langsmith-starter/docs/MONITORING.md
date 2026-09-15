# Navio agent monitoring — Supabase traces + `/monitoring` dashboard

**Since:** 2026-09-14 · **Spec:** `../../docs/superpowers/specs/2026-09-14-navio-monitoring-design.md`
· **Plan:** `../../docs/superpowers/plans/2026-09-14-navio-monitoring.md`

Every agent execution of the Navio widget — a FAQ turn or a V3 partner turn — becomes a **trace** with
ordered, nested **steps** in a dedicated Supabase project, together with every 👍/👎 vote, and is
browsable in a password-protected dashboard at **`/monitoring`** inside the widget app. Anyone on the
team can open an execution and answer:

> What did the user ask? → What did the agent do? → What happened at every step? → Which tools were
> used, with which inputs/outputs? → How long and how much did it cost? → What was the final answer?
> → How did the user react?

Langfuse is **unchanged** (exporter, hooks, scores, queues, dashboards). This is an additional layer.

---

## 1. Architecture

```
browser ── /eve/v1/*  ──► eve FAQ agent ──► agent/hooks/monitoring.ts ─┐   (incremental: running → KB → model → delivered/failed)
                                                                       │
browser ── /api/partner/workflow ──► lib/partner-workflow.ts ──► V3    │
                                     └─ observe → lib/monitoring/partner-capture.ts ─┤   (whole WorkflowTrace, 5 s cap)
                                                                                     │
browser ── /api/feedback ──► lib/monitoring/feedback.ts ─────────────────────────────┤   (both surfaces)
                                                                                     ▼
                                                    lib/monitoring/store.ts ── RPC monitoring_write_trace / _record_feedback
                                                                                     ▼
                                                              Supabase (separate project, service-role, RLS on / no policies)
                                                                                     ▲
/monitoring/*  ◄── middleware.ts (signed cookie) ◄── app/monitoring/* pages ◄── lib/monitoring/query.ts
/api/monitoring/{traces,stats,sessions}  (same guard; for scripts and curl)
```

| File (`kb-agent-langsmith-starter/`) | Role |
|---|---|
| `lib/monitoring/env.ts` | env readers; `isMonitoringEnabled()`, `dashboardEnabled()`, `agentVersion()` |
| `lib/monitoring/types.ts` | `TraceDraft` / `StepDraft` / `FeedbackDraft` — the one shape both agents produce |
| `lib/monitoring/store.ts` | the writer: one RPC per write, one retry, never throws, buffered `events` |
| `lib/monitoring/faq-mapper.ts` + `agent/hooks/monitoring.ts` | FAQ: eve events → draft fragments, written incrementally |
| `lib/monitoring/v3-mapper.ts` + `partner-capture.ts` | Partner: `WorkflowTrace` → draft, written once |
| `lib/monitoring/feedback.ts` | votes → `feedback` rows, linked to the trace |
| `lib/monitoring/describe.ts` / `pricing.ts` | plain-language step titles/purposes; the shared price table |
| `lib/monitoring/auth.ts` + `middleware.ts` + `app/api/monitoring/auth` | login, cookie, guard |
| `lib/monitoring/query.ts` + `app/api/monitoring/*` | read side |
| `app/monitoring/*`, `components/monitoring/*` | the screens |
| `supabase/migrations/*.sql` | schema + Postgres functions (source of truth) |
| `scripts/monitoring-verify.ts`, `scripts/monitoring-reconcile.ts` | end-to-end check; housekeeping |

**Why one RPC with merge semantics.** A FAQ turn spans several serverless invocations, so the hook cannot
hold the whole trace in memory. It writes a `running` row on `message.received` and every later event
sends only what it knows; `monitoring_write_trace` upserts the trace by `(session_id, turn_id)` and each
step by `(trace_id, step_key)`, never replacing a stored value with null. The partner path writes the
whole trace in one call because V3 already returns everything.

---

## 2. Data model (schema `public`)

| Table | What a row is |
|---|---|
| `agent_sessions` | one conversation (`id` = the widget's session id), `turn_count`, first/last seen |
| `traces` | one execution: agent, `turn_id` (`turn_N`, the feedback key), status, timing, tokens, cost, `user_input`, `final_output`, `feedback_thumb` (latest vote), `metadata` |
| `trace_steps` | one step: `kind` (request · llm · tool · retrieval · transform · response · error · group), `name`, `title`, `purpose`, status, duration, `input`/`output` JSON, model/tokens/cost, warnings, error; `parent_step_id` for V3 task groups; `step_key` = upsert key |
| `feedback` | append-only: every vote, flip, retraction and comment; `trace_id` null until linked |
| `errors` | classified errors and warnings per trace/step (`type` from `FAILURE_PATTERNS`, else `unclassified`) |
| `events` | the monitoring system's own log: `trace.write_failed`, `feedback.unlinked`, `feedback.partner_forward_failed`, `partner.upstream_error`, `trace.abandoned` |
| `prompt_versions` | each distinct FAQ system prompt once (sha256, size, sections, content) |

Trace status: `running` · `completed` · `needs_clarification` · `partial` · `failed`. A trace still
`running` after 5 minutes is shown as **abandoned** and marked `failed` by `monitoring:reconcile`.

### Step mapping

**FAQ:** `request-received` → `load-knowledge-base` (prompt fingerprint + version) → `generate-answer`
(model, tokens, cost) → `answer-delivered`; `failure` appended on `step.failed` / `turn.failed` /
`session.failed`; a `tool:<name>:<n>` step for any future tool call.

**Partner (V3):** `request-received` → `decompose` (llm) → one **group** `task:<id>` per search task
(children: `detect-city`, `reformulate`, `nearby-cities`, `search` [tool `similarity_search`], `rerank`,
`respond`) → `answer-composed`. A task that needs clarification is a `warning` group carrying the
clarification; stage `warnings`, `error`, `config`, `counts`, `filters` are copied verbatim.

---

## 3. Setup

1. **Supabase:** create a new project; apply `supabase/migrations/20260914000100_monitoring_schema.sql`,
   then `…000200_monitoring_rpc.sql`, then `…20260915000100_alerting_schema.sql`, then
   `…20260915000200_alerting_cron.sql` (needs the two Vault secrets first — see
   `MONITORING-ALERTING.md` § Supabase rules), only after the widget is deployed with the
   feature, `…20260915000300_alerting_cron_production.sql`, then
   `…20260915000400_monitoring_delete.sql` (Supabase MCP `apply_migration`, or the
   SQL editor). Tables have RLS on with no policies: only the service-role key can read or write.
2. **Env** (`.env.local` locally, Vercel project `navio-widget` for preview + production, then redeploy):

   | Variable | Required | Notes |
   |---|---|---|
   | `MONITORING_SUPABASE_URL` | to enable | the new project's URL |
   | `MONITORING_SUPABASE_SERVICE_ROLE_KEY` | to enable | server-only, sensitive |
   | `MONITORING_PASSWORD` | dashboard | unset ⇒ `/monitoring/*` and the data API return **404** |
   | `MONITORING_COOKIE_SECRET` | dashboard | ≥ 32 random bytes (`openssl rand -hex 32`) |
   | `MONITORING_ENVIRONMENT` | optional | stored in `traces.metadata.env`; defaults to `VERCEL_ENV`, then `NODE_ENV` |

   All blank ⇒ every monitoring surface is a silent no-op; a fresh clone runs credential-free.
3. **V3** needs nothing new — the usage surfacing is part of its code.
4. **Check:** with the widget (`:3001`) and V3 (`:3008`) running, `npm run monitoring:verify` → 23 ✓.

---

## 4. Using the dashboard

- **Login:** `/monitoring` → shared password → signed httpOnly cookie (`navio_monitoring`, 7 days,
  `SameSite=Lax`, `Secure` in production). 5 wrong passwords per IP per 15 min → 429.
- **Overview:** KPI tiles (executions, success rate, failed/abandoned, avg + p95 latency, cost, 👍 rate,
  👍, 👎), executions-per-day bars (green = FAQ, orange = Partner), latest errors, and the trace list
  with filters (range, agent, status, feedback, search). "Load more" pages by cursor.
- **Trace detail:** header (status · duration · steps · tool calls · cost · vote), *What the user
  asked / What Navio answered*, errors & warnings, the **timeline** (vertical rail; V3 task groups as
  side-by-side lanes under "Split into search tasks"). Each card: plain-language title + one-sentence
  purpose, duration bar, status. Expanded: Input / Output (tables for candidate, ranking and
  recommendation lists, raw JSON with Copy and "Show all"), Config, Warnings, Error, and **Technical
  details** (ids, model, tokens, cost, metadata). Right rail: prompt version (fingerprint + "Open full
  prompt"), models & cost, session link, feedback history with comments, build version.
  Keyboard: `j`/`k` next/previous step, `Enter`/`Space` toggle, `e` expand all, `c` collapse all.
- **Session view:** all turns of one conversation as a thread, each linking to its trace.
- **Alerts page** (`/monitoring/alerts`, added 2026-09-15 — see `docs/MONITORING-ALERTING.md` §
  "Supabase rules"): **Feed** tab lists `alert_events` newest first (fired/recovered/digest/test),
  each row showing severity, rule, agent, observed vs. threshold, window and delivery status per
  channel; unresolved breaches get a **"Bestätigen"** (acknowledge) button that records who and
  when. **Regeln** tab is the `alert_rules` table with inline editing (enabled, severity,
  threshold, window, min samples) plus recipients and the digest toggle, and three action
  buttons: **"Vorschau auswerten"** (dry run — narrates but never writes state or sends
  anything), **"Jetzt auswerten"** (a real `slot: "manual"` evaluation), and **"Testalarm
  senden"** (one test card + one test email, no rule evaluation). The overview page shows a red
  banner and `HeaderNav` a red dot when any rule is currently breached.
- **Theme:** 🌙/☀️ in the header (remembered per browser). Works at 400 px width.

---

## 5. Feedback

`POST /api/feedback` persists **every** vote (both surfaces) before the existing Langfuse logic runs:
resolve the trace by `(session_id, turn_id)`, insert the row, refresh `traces.feedback_thumb`. A vote
that beats the trace write is stored with `trace_id = null` and back-linked when the trace completes
(or by `monitoring:reconcile`). `thumb: null` is a retraction row. Partner votes on V3 answers are
persisted here for the first time (the Langfuse forward to `${PARTNER_AGENT_HOST}/api/feedback` still
has no V3 counterpart; its failure is now an `events` row `feedback.partner_forward_failed`).

---

## 6. Operations

| Command | Purpose |
|---|---|
| `npm run monitoring:verify` | one FAQ + one partner turn through the running widget, a vote on each, then reads Supabase back (23 checks); `--expect-failure` for the error path |
| `npm run monitoring:reconcile` | marks `running` > 5 min as abandoned (+ event), links leftover votes, refreshes `feedback_thumb`; idempotent, schedule it |
| `npm run alerts:verify` | against a running widget + the real monitoring Supabase: seeds a failure-rate breach, evaluates, asserts `fired` + a Teams send, clears it, asserts `recovered`, asserts a third run is a no-op and never re-sends the digest, cleans up its rows. Posts one real red + one real green card to the Navio Alerts Teams channel — see `docs/MONITORING-ALERTING.md` § "Supabase rules" |
| `npm test` / `npm run typecheck` | 15 monitoring test files are part of the suite |

**Alert scheduler (Supabase `pg_cron`)** — full detail in `docs/MONITORING-ALERTING.md` §
"Supabase rules": `select jobname from cron.job;` lists the active jobs. To unschedule/reschedule
by hand:

```sql
select cron.unschedule('navio-alerts-test');                                         -- test cadence off
select cron.schedule('navio-alerts-test', '*/5 * * * *',
  $$select monitoring_call_evaluate('test')$$);                                      -- test cadence back on
select cron.unschedule('navio-alerts-morning'); select cron.unschedule('navio-alerts-afternoon'); -- production off
```

Log lines to grep on Vercel: `[monitoring]` (writer/capture failures, shape-only), `MONITORING
feedback:` (one per vote, `linked: true|false`), `[partner-workflow] observer failed`,
`[alerts:evaluate] failed` (evaluate route threw).

**Invariants** (mirroring the Langfuse layer): no credentials ⇒ silent no-op · monitoring never throws
into an agent or route · a write never delays a visitor's answer by more than the 5 s cap and never
fails it · the browser never sees a Supabase key · full visitor text is stored (owner decision).

---

## 7. Known limits

- A FAQ fragment landing on a cold instance whose `/tmp` turn-state is missing writes under
  `turn_unknown`; the running row keeps the real id. Rare; visible as a second trace.
- The Langfuse forward for partner votes still 502s against V3 (recorded as an event, not fixed).
- No retention policy yet — `traces`/`trace_steps` grow unbounded; add a scheduled delete when needed.
- The login throttle is per serverless instance; the Vercel Firewall is the real control.
- Next 15.5 middleware runs with `runtime: "nodejs"` (the edge bundle failed to load under this
  project's dev server); Next 16 renames the file to `proxy.ts`.
- Dashboard tests cover the pure logic (`format.ts`, `timeline-model.ts`, query helpers); the React
  components are verified in the browser, not by vitest (no JSX transform in this project).
