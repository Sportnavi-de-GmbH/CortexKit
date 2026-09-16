# Navio monitoring — automated alerting (Supabase rules → Teams + email)

**Date:** 2026-09-15 · **Branch:** `main` · **Status:** approved design, not implemented

## 1. Goal

An automated alert system on top of the Supabase monitoring layer (spec
`2026-09-14-navio-monitoring-design.md`). A scheduled evaluator applies threshold rules to the
same tables the `/monitoring` dashboard reads (`traces`, `errors`, `feedback`), and when a rule
is breached or recovers it notifies the team's **Teams channel "Navio Alerts"** and the
**configured email recipients**. Every run also posts a short, LLM-written status digest to
Teams. Alerts, rules and recipients are visible and editable in the dashboard.

The team must be able to answer, from the Teams card or the email alone: *which agent, which
metric, what value against what threshold, over which window, and what to check first.*

## 2. Scope and non-goals

**In scope**

- Rule evaluation from Supabase data, production traffic only (`traces.metadata->>'env' = 'production'`).
- Scheduling with `pg_cron` + `pg_net` inside the monitoring Supabase project, calling one
  endpoint in the widget app.
- Delivery through the **existing** senders `lib/monitoring/teams.ts` (Adaptive Card to the
  Workflows webhook) and `lib/monitoring/graph-mail.ts` (Microsoft Graph `sendMail`). No Resend,
  no SMTP: Graph is configured on Vercel and was verified live on 2026-09-09.
- LLM-written narrative for alerts and the digest, with a deterministic fallback.
- Dashboard: alert feed with acknowledge, rules editor, recipients, "run now (preview)", "send test
  alert", breach banner on the overview.

**Out of scope / unchanged**

- The Langfuse Monitors → relay path (`app/api/monitoring/alerts/{faq,partner,orchestrator}`)
  keeps working untouched. Retiring or recalibrating it is a separate task.
- Snooze, per-severity recipient lists, paging/escalation, SMS.
- Any change to agents, prompts, the widget UI, or the trace write path.
- Alerts for the orchestrator (it does not write to the monitoring Supabase).

## 3. Decisions taken in the interview

| Question | Decision |
|---|---|
| Alert source | Supabase-driven evaluator in the widget app, not Langfuse Monitors |
| Trigger | `pg_cron` in Supabase → `pg_net` POST → widget endpoint with a bearer secret |
| Rules v1 | cost daily, cost spike vs baseline, failure rate, latency p95, negative feedback rate, repeated error type, partner upstream unavailable |
| Notify policy | on transition (ok → breached) and on recovery; silent while it stays breached |
| Digest | every scheduled run, Teams only, written by the LLM |
| Message authoring | rules decide deterministically; the LLM only phrases the result; template fallback |
| Cadence | production 07:00 and 15:00 Europe/Berlin; a 5‑minute job for testing, removed before go‑live |
| Thresholds | `alert_rules` table seeded with defaults, editable in the dashboard |
| Recipients | one list in `alert_settings`, `ALERT_EMAIL_TO` as fallback; Teams URL stays in env |
| Dashboard | `/monitoring/alerts` page (feed + rules) and a breach banner on the overview |
| Acknowledge | yes (who/when on the event row); no snooze |

## 4. Data model (monitoring Supabase project, one migration)

```sql
create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  key text not null,                    -- cost_daily | cost_spike | failure_rate | latency_p95
                                        -- | negative_feedback | error_repeat | partner_upstream
  agent text not null default 'all' check (agent in ('all','faq','partner')),
  enabled boolean not null default true,
  severity text not null default 'alert' check (severity in ('warning','alert')),
  threshold numeric not null,           -- unit depends on key (usd, ratio 0–1, ms, count, multiplier)
  window_hours int not null,
  min_samples int not null default 0,
  params jsonb not null default '{}',   -- rule-specific extras (e.g. cost_spike: {"min_abs_usd":0.5})
  description text not null default '',
  updated_at timestamptz not null default now(),
  unique (key, agent)
);

create table alert_state (
  rule_id uuid not null references alert_rules(id) on delete cascade,
  agent text not null,                  -- resolved agent (rules with agent='all' expand per agent + total)
  subkey text not null default '',      -- error_repeat: the errors.type; otherwise ''
  status text not null check (status in ('ok','breached','error')),
  observed numeric,
  samples int,
  last_evaluated_at timestamptz not null,
  last_transition_at timestamptz,
  primary key (rule_id, agent, subkey)
);

create table alert_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('fired','recovered','digest','test')),
  rule_key text,                        -- null for digest
  agent text,
  subkey text not null default '',
  severity text,
  observed numeric,
  threshold numeric,
  samples int,
  window_hours int,
  window_from timestamptz,
  window_to timestamptz,
  narrative text not null,              -- the message that was sent
  narrative_source text not null check (narrative_source in ('llm','template')),
  delivery jsonb not null default '{}', -- {"teams":"sent|skipped|failed: …","email":"…"}
  run_slot text not null,               -- e.g. 2026-09-15T07:00+02:00 ; makes a digest idempotent
  acknowledged_by text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);
create index alert_events_created_idx on alert_events (created_at desc);
create unique index alert_events_digest_slot_idx on alert_events (run_slot) where kind = 'digest';

create table alert_settings (
  id int primary key default 1 check (id = 1),
  email_recipients text[] not null default '{}',
  digest_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into alert_settings (id) values (1);
```

All four tables: RLS on, no policies (service role only), like the rest of the schema.

**Seeded rules (defaults; the team edits them in the dashboard):**

| key | agent | severity | threshold | window_h | min_samples | params |
|---|---|---|---|---|---|---|
| `cost_daily` | all | alert | 2.00 USD total | 24 | 0 | `{"per_agent_usd":1.5,"window":"berlin_day"}` |
| `cost_spike` | all | warning | 3.0 × baseline | 24 | 0 | `{"min_abs_usd":0.5,"baseline_days":7}` |
| `failure_rate` | all | alert | 0.10 | 24 | 10 | |
| `latency_p95` | faq | warning | 8000 ms | 24 | 10 | |
| `latency_p95` | partner | warning | 60000 ms | 24 | 10 | |
| `negative_feedback` | all | warning | 0.30 | 168 | 5 | |
| `error_repeat` | all | warning | 5 (count) | 24 | 0 | |
| `partner_upstream` | partner | alert | 3 (count) | 24 | 0 | `{"error_type":"upstream_unavailable"}` |

Semantics:

- `failure_rate` = (`status in ('failed')` + abandoned, i.e. `running` older than the abandonment
  cut‑off already used by `traceIsAbandoned`) / all traces in the window.
- `cost_spike` compares the last 24 h sum of `cost_estimate_usd` with the mean daily sum of the
  previous 7 full days. It is **skipped** (state `ok`, digest says "warming up") until 7 days of
  production data exist, and never fires below `min_abs_usd`.
- `error_repeat` groups `errors.type` (level `error`) over the window; each type is its own
  `alert_state` row via `subkey`. `partner_upstream` is the specific, higher‑severity version for
  `upstream_unavailable` on partner traces; `error_repeat` ignores that type to avoid double alerts.
- "Berlin day" for `cost_daily` = from local midnight to now, computed in code with
  `Intl.DateTimeFormat` for `Europe/Berlin`.

**Scheduling (same migration):**

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- The evaluate URL and bearer secret live in Vault, never in the migration text:
--   vault.create_secret('https://navio-widget.vercel.app/api/monitoring/alerts/evaluate', 'alert_evaluate_url');
--   vault.create_secret('<ALERT_EVALUATE_SECRET>', 'alert_evaluate_secret');
create or replace function monitoring_call_evaluate(p_slot text) returns bigint ...  -- reads Vault, net.http_post
select cron.schedule('navio-alerts-morning',   '0 5 * * *',  $$select monitoring_call_evaluate('scheduled')$$); -- 07:00 CEST / 06:00 CET
select cron.schedule('navio-alerts-afternoon', '0 13 * * *', $$select monitoring_call_evaluate('scheduled')$$); -- 15:00 CEST / 14:00 CET
-- testing only, unscheduled before go-live:
select cron.schedule('navio-alerts-test', '*/5 * * * *', $$select monitoring_call_evaluate('test')$$);
```

pg_cron runs in UTC and has no timezone support. The two production jobs are written for
summer time; the migration comment documents that they drift by one hour in winter, and the
runbook has the two `cron.alter_job` lines to shift them. Wintertime accuracy is not a
requirement (two digests a day at roughly 7 and 15 o'clock).

## 5. Evaluator — `POST /api/monitoring/alerts/evaluate`

Auth: `Authorization: Bearer ${ALERT_EVALUATE_SECRET}`; anything else → 401. Missing env
secret → 404 (feature off), consistent with `dashboardEnabled()`.

Body: `{ "slot": "scheduled" | "test" | "manual", "dryRun"?: boolean }`. `runtime = "nodejs"`,
`maxDuration = 60`.

Flow (`lib/monitoring/alerts/evaluate.ts`):

1. Load enabled rules, current `alert_state`, `alert_settings`.
2. For each rule, in parallel with a per‑rule `try/catch`: compute the observation from the
   tables (production only), decide `ok | breached`, or `error` if the query threw. Rules with
   `agent = 'all'` produce one observation per agent plus `total` where meaningful (cost, failure).
3. Diff against `alert_state` → list of transitions: `fired` (ok/absent → breached),
   `recovered` (breached → ok). `error` never transitions and never notifies; it shows in the
   digest.
   **A state row that belongs to an evaluated (enabled) rule but received no observation this
   run is treated as `ok`; if it was `breached` that is a `recovered` transition. State rows of
   disabled rules are deleted.** (Without this, an `error_repeat` subkey whose error type stops
   occurring stays breached forever, and the rule can never fire for that key again.)
   On the first run every currently breached rule fires; this is intended — it is the initial
   inventory.
4. Build the digest (every rule: status, observed, threshold, samples).
5. `narrate()` (§6) for each transition and for the digest.
6. Unless `dryRun`: write `alert_state`, insert `alert_events`, then deliver (§6). Delivery results
   are written back onto the event rows.
7. Return `{ ok, slot, transitions: [...], digest, delivery }` — the dashboard's preview shows
   exactly this.

Idempotency: `run_slot` = the scheduled slot rounded to the hour in Berlin time (`test` and
`manual` slots use the minute). The digest insert is `on conflict do nothing`; if nothing was
inserted, the digest is not sent. Transitions are inherently idempotent because state is
updated in the same run.

Rule queries are plain SQL through the existing service‑role client (`lib/monitoring/store.ts`
pattern), one aggregate query per rule, all filtered on `started_at` and `metadata->>'env'`.
The two existing indexes (`traces_agent_started_idx`, `errors_created_idx`) cover them.

## 6. Messaging

**Narration** (`lib/monitoring/alerts/narrate.ts`): one call to the Azure model from
`lib/llm.ts` (`generateText`, `maxOutputTokens` 400, 8 s timeout) with a fixed system prompt:

- write in German, plain language, no markdown headings; one paragraph for an alert, at most
  120 words; name the agent, the metric, the observed value, the threshold and the window;
  end with one concrete first check (e.g. "Azure‑429 in den Fehlern prüfen", "Partner‑Agent
  Deployment prüfen");
- never invent numbers: only those in the input JSON may appear; no apologies.

The model never decides whether something is an alert. On any failure or timeout the
template renderer produces the message instead, and `narrative_source = 'template'` records
it. The digest narration receives the whole rule table and writes 2–4 sentences ("Alles im
grünen Bereich, Kosten heute 0,12 $ …").

**Delivery** (reusing `sendTeamsAlert` / `sendAlertEmail` with the existing `AlertMessage`
shape, `projectLabel = "Navio Monitoring"`):

| Event | Teams | Email |
|---|---|---|
| `fired` | card: 🔴/🟡 severity, rule title, narrative, value vs threshold, link to `/monitoring/alerts` | subject `[Navio Monitoring] ALERT: <rule> (<agent>)`, same body |
| `recovered` | card 🟢, narrative | subject `[Navio Monitoring] RECOVERED: …` |
| `digest` | one card: narrative + a `FactSet` with every rule (status, value, threshold) | — |
| `test` | card "Testalarm" | email "Testalarm" |

`format-alert.ts` gains one function, `toMonitoringAlertMessage(event)`, so both channels keep
reading the same struct; the Adaptive Card gets an optional `facts` list for the digest.
Recipients = `alert_settings.email_recipients`, falling back to `ALERT_EMAIL_TO`. The digest
is sent only when `alert_settings.digest_enabled` is true **and** `slot = 'scheduled'`, so the
5‑minute test cron never floods the channel; test runs still write digest events for the feed.

## 7. Dashboard

Route `/monitoring/alerts` (behind the existing cookie middleware), built from
`components/monitoring/ui.tsx` primitives, lucide icons, responsive 375–1440, dark mode.

- **Feed tab**: `alert_events` newest first, filters kind/agent, each row shows severity pill,
  rule, agent, observed vs threshold, window, narrative (collapsed), delivery status per channel,
  and a link to `/monitoring/traces?agent=…&from=…&to=…`. "Bestätigen" button → `POST
  /api/monitoring/alerts/ack` stores `acknowledged_by` (free text name, remembered in
  `localStorage`) and time. Digest rows are collapsed by default.
- **Regeln tab**: table of `alert_rules` with inline edit of enabled, severity, threshold,
  window, min_samples; `PATCH /api/monitoring/alerts/rules/:id`. Recipients field and digest
  toggle → `PATCH /api/monitoring/alerts/settings`. Buttons: **"Jetzt auswerten (Vorschau)"**
  (calls evaluate with `dryRun`, shows the result inline), **"Jetzt auswerten"** (real run,
  `slot = 'manual'`), **"Testalarm senden"** (`POST /api/monitoring/alerts/test`, one card +
  one email, event kind `test`).
- **Overview banner**: `GET /api/monitoring/alerts/status` returns breached states; the overview
  page shows a red banner "N Regeln verletzt" linking to the feed. `HeaderNav` gets an
  "Alerts" entry with a red dot while breached.

API routes: `events` (GET, cursor paging like traces), `rules` (GET/PATCH), `settings`
(GET/PATCH), `ack` (POST), `test` (POST), `status` (GET), `evaluate` (POST, bearer, also
callable from the dashboard through a server action that injects the secret).

## 8. Configuration

| Variable | Where | Notes |
|---|---|---|
| `ALERT_EVALUATE_SECRET` | widget (Vercel + `.env.local`), Supabase Vault | unset ⇒ evaluate returns 404, cron calls are harmless |
| `TEAMS_ALERT_WEBHOOK_URL` | existing | unset ⇒ Teams skipped |
| `MS_GRAPH_*`, `ALERT_EMAIL_TO` | existing | unset ⇒ email skipped |
| `AZURE_AI_CHATBOT_*` | existing | narration; unset ⇒ template |
| `MONITORING_SUPABASE_*` | existing | unset ⇒ whole feature no‑op |

Local testing: run the widget on 3001, expose it with a tunnel or call evaluate by hand with
`curl`; the Supabase cron targets production only (Vault URL).

## 9. Error handling and invariants

- Missing config anywhere degrades to a no‑op, never a thrown error (repo rule).
- A notification failure is recorded on the event and does not roll back the state transition,
  so an outage of Teams cannot cause a rule to re‑fire on every run.
- A rule whose query throws is reported as `error` in the digest and feed, never as `ok`.
- Evaluate runs rules in parallel and caps total time; the route never exceeds 60 s.
- The LLM output is stored verbatim as sent; the numbers shown in the card's fact list come
  from the evaluation, not from the narrative, so a wrong sentence can never hide the real value.
- Nothing here changes the trace write path or the existing Langfuse relay.

## 10. Testing and validation

**Vitest (`tests/alerts.test.ts`)**: each rule's decision with fixture stats (below/at/above
threshold, min_samples not met, spike warm‑up skip, Berlin‑day boundary), transition diffing
(fired/recovered/no‑op/error), digest slot idempotency, narrative fallback on model failure,
bearer rejection, recipients fallback.

**Live (`npm run alerts:verify`)**: with the widget and Supabase running: (1) insert a small
batch of failed production‑tagged traces in a throwaway session; (2) call evaluate `slot=test`;
assert a `fired` event for `failure_rate` with `delivery.teams = sent`; (3) mark those traces
completed; call again; assert `recovered`; (4) call a third time; assert no new transition and
no second digest for the slot; (5) delete the throwaway session. Then confirm the 5‑minute
cron reaches Vercel: `select * from cron.job_run_details order by start_time desc limit 5`
plus a `net._http_response` row with status 200.

**Go‑live checklist**: set `ALERT_EVALUATE_SECRET` on Vercel + Vault, redeploy, run the live
check against production once, `cron.unschedule('navio-alerts-test')`, watch the 07:00 digest.

## 11. Implementation order

1. Migration: tables, seed, Vault‑backed `monitoring_call_evaluate`, cron jobs (test job only
   at first).
2. `lib/monitoring/alerts/`: `rules.ts` (queries + decisions), `evaluate.ts` (diff, state,
   events), `narrate.ts`, `deliver.ts`; unit tests first.
3. `/api/monitoring/alerts/evaluate` + bearer auth; live check script.
4. Remaining API routes and the `/monitoring/alerts` page, banner, nav entry.
5. Docs: `docs/MONITORING-ALERTING.md` gets a "Supabase rules" section; CLAUDE.md §17 pointer.
6. Production cron jobs, go‑live checklist.
