# Navio Monitors → Teams + Email alerting

Threshold-based alerts on cost, latency, errors, volume and quality across Navio's three
wired Langfuse projects (`Navio — FAQ`, `Navio — Partner`, `Navio — Multi-Agent`), delivered
to Microsoft Teams and email. Closes `docs/PRODUCTION-READINESS-REVIEW.md` §G6, the one
open gap ("no alerting") in an otherwise production-grade observability stack.

Code built and unit-tested 2026-08-19 (43 tests, `tests/monitoring-*.test.ts`). **Live
verification is a separate, manual step** — see [Testing procedure](#testing-procedure) —
because Langfuse Monitors, the Teams webhook, and the Azure AD app permission are all
configured by hand in their respective UIs; nothing here can script that part.

## What an on-call engineer sees

**Teams** (posted to whatever channel the Workflow was created in):

> 🔴 **ALERT** — Navio — Partner
>
> **avg latency crossed alert threshold**
>
> avg latency is 94213 ms (threshold: 90000 ms) over the last 1h
>
> [Open in Langfuse](https://sportnavi-langfuse.sportnavi.de/project/.../monitors/...)
>
> _2026-08-19T10:30:00Z_

**Email** — subject `[Navio — Partner] ALERT: avg latency crossed alert threshold`, same
facts as HTML.

Both come from the exact same `AlertMessage` (`lib/monitoring/format-alert.ts`) — title,
severity, metric detail, project, permalink and timestamp render identically on both
channels because there is exactly one place that derives them from the raw Langfuse
payload, and two renderers.

## Architecture

```
Langfuse project (FAQ / Partner / Multi-Agent)
  Monitor(s) — cost / latency / errors / volume / quality, configured in the Langfuse UI
       │  severity transition (breach, recovery, or sustained-NO_DATA)
       ▼
  ONE Webhook Automation per project (all of that project's monitors share it)
       │  HTTP POST, HMAC-SHA256 signed — x-langfuse-signature: t=<unix>,v1=<hex>
       ▼
kb-agent-langsmith-starter  (navio-widget — the one deployed public Vercel project)
  app/api/monitoring/alerts/{faq,partner,orchestrator}/route.ts
       │  lib/monitoring/relay.ts: verify → parse → dedupe → format
       ├──────────────────────────────┬─────────────────────────────
       ▼                              ▼
  lib/monitoring/teams.ts       lib/monitoring/graph-mail.ts
  POST TEAMS_ALERT_WEBHOOK_URL  POST /users/{upn}/sendMail via Microsoft Graph
  (Teams "Workflows" webhook)   (existing "navio-chatbot" Azure AD app, Mail.Send)
       ▼                              ▼
  Teams channel                 ALERT_EMAIL_TO
```

One relay serves all three Langfuse projects (each with its own webhook secret) and both
destinations, deployed only in the already-linked `navio-widget` Vercel project — no new
service, no new vendor, no new dependency. Both downstream calls use plain `fetch` (no SDK),
matching this repo's existing style in `lib/langfuse.ts` and `lib/contact/salesforce.ts`.

**Why Teams uses a Workflows webhook and not Graph.** An app-only Graph alternative
(`ChannelMessage.Send`) was evaluated and rejected: verified live against
`learn.microsoft.com/graph/api/channel-post-messages` that Application-permission channel
posting is restricted to the message-*migration* API (`Teamwork.Migrate.All`), which is not
intended for live notifications and which Microsoft has floated charging for. The Workflows
webhook's one real downside — Microsoft's own docs note a workflow is owned by whoever
creates it and can become an "orphan flow" — is mitigated by adding co-owners (below), not by
standing up a full Teams bot registration.

## Data model — Monitors are configured BY HAND, not by code

Langfuse's Monitors/Alerts feature has **no creation API** (confirmed: zero monitor/alert
paths in this instance's own `/generated/api/openapi.yml`, and no `createMonitor`-shaped MCP
tool). Every row below is a runbook for the Langfuse UI, not something `setup-monitors.ts`
could create — unlike the feedback-score setup script, there is nothing to automate here.

Two counting rules from `docs/LANGFUSE-DASHBOARD.md` are load-bearing — get these wrong and a
monitor alerts on garbage:
- **Count the per-turn summary span, never the trace root.** `visitor-request` /
  `workflow.route.flow` fires on every eve workflow poll, not once per visitor turn — it
  over-counts by ~350×. Use `answer-delivered` (FAQ/Partner) or `request-completed`
  (Orchestrator).
- **Never count ERROR-level observations as a failure count.** One real failure marks 7
  observations ERROR. Filter the summary span by its `outcome:failed` **tag** instead — tags
  are explicitly confirmed filterable in the Monitors UI, unlike `metadata`.
- **Cost is only priced on the GENERATION span** (`generate-answer` / `model-call`) — the
  summary span's `cost.estimate_usd` is a metadata *string*, not an aggregatable measure.

**TTFT is not shipped in v1 — this is a known, documented gap, not a silent substitution.**
`docs/LANGFUSE-DASHBOARD.md` §3 already records that `completionStartTime` is never set on
any generation, so Langfuse's native time-to-first-token measure is unusable today (only
`timing.first_token_ms` exists, buried in trace metadata, unreachable by a Monitor's
aggregation). This ships **turn latency** (full duration on the summary span) as the
pragmatic stand-in instead — readily available, and for Partner specifically a *better*
signal than TTFT alone since it also covers the deterministic search-pipeline stage between
model calls. Wiring `completionStartTime` for a true TTFT monitor is a small, already-
diagnosed fast-follow in `agent/instrumentation.ts` — deliberately not part of this change,
since it touches tuned files outside "alerting."

**Errors are a count, not a rate.** Langfuse's measure set has no ratio/division measure —
the same platform limitation the dashboard doc documents for widgets. Thresholds below are
picked relative to each project's known volume.

**Cache-hit-ratio-drop** (also named in §G6) is a regression-detector pattern, not a static
threshold, and is **not** covered here — tracked as a separate fast-follow, not dropped.

| Project | KPI | Data source · metric | Filter | Window | Warning | Alert | No-data handling | Renotify |
|---|---|---|---|---|---|---|---|---|
| FAQ | Latency (p95 turn) | Observations · p95 latency | `name = "answer-delivered"` | 1h | > 8,000 ms | > 15,000 ms | treat as 0 | off |
| FAQ | Errors | Observations · count | `tags contains "outcome:failed"`, `name = "answer-delivered"` | 1h | ≥ 3 | ≥ 8 | treat as 0 | off |
| FAQ | Volume / heartbeat | Observations · count | `name = "answer-delivered"` | 6h | — | count < 1 | **notify after sustained NO_DATA** (~6h) — the real outage detector | off |
| FAQ | Cost (daily) | Observations · sum cost | `name = "generate-answer"` | 1d | ≈1.5× a real 7-day baseline (pull via dashboard first) | ≈3× baseline | treat as 0 | off |
| FAQ | Quality | Scores · avg | `name = "user-feedback"` | 24h (7d if sparse) | < 0.7 | < 0.5 | **keep previous value** (treat-as-0 would falsely read "collapsed" on a quiet no-votes period) | off |
| Partner | Latency (p95 turn) | Observations · p95 latency | `name = "answer-delivered"` | 1h | > 60,000 ms | > 90,000 ms | treat as 0 | off |
| Partner | Errors | Observations · count | `tags contains "outcome:failed"`, `name = "answer-delivered"` | 1h | ≥ 2 | ≥ 5 | treat as 0 | off |
| Partner | Volume / heartbeat | Observations · count | `name = "answer-delivered"` | 12h (lower baseline traffic than FAQ) | — | count < 1 | notify after sustained NO_DATA (~12h) | off |
| Partner | Cost (daily) | Observations · sum cost | `name = "generate-answer"` | 1d | ≈1.5× (baseline ≈$0.001964/turn, root `CLAUDE.md` §16.7, × real 7-day turn count) | ≈3× | treat as 0 | off |
| Partner | Quality | Scores · avg | `name = "user-feedback"` | 24h/7d | < 0.7 | < 0.5 | keep previous value | off |
| Orchestrator | Latency / Errors / Volume / Cost | same shape, filtered on `request-completed` / `model-call` — **re-verify live, do not copy FAQ/Partner names** | | | *set after a real baseline* | | | |

Exact filter-dropdown availability (whether `name`/`tags` appear directly vs. needing the
underlying Metrics-API-style filter) should be confirmed live when creating the first
monitor — the docs describe the field set but don't exhaustively enumerate the UI dropdown.

## Verified live 2026-09-09 — and what was broken

First end-to-end audit after the build. The relay half was healthy; the
**Langfuse → relay** half was not, and no alert had ever been delivered.

| Finding | Fix applied |
|---|---|
| **Both Webhook Automations pointed at a dead ngrok tunnel** (`fidgeting-reps-dreamless.ngrok-free.dev`) — the local-dev URL from the build session. The host answers 404. | Repointed both to `https://navio-widget.vercel.app/api/monitoring/alerts/{faq,partner}` |
| **The FAQ automation had been auto-disabled** ("Inactive") — exactly the documented 5-consecutive-failures behaviour, caused by the dead URL | Re-enabled |
| FAQ — Latency had **no filter at all**: p95 across *every* span type, not turn latency (unfiltered 7,199 ms vs 6,041 ms filtered), with a warning threshold of 7,989 ms sitting inside that noise | Added `Observation Name any of answer-delivered`; warning → a round 8,000 ms |
| FAQ — Volume/heartbeat was **PAUSED** since 2026-08-20 — the outage detector was off | Resumed |
| FAQ — Quality had **renotify = every 1 minute**: a real breach would page Teams + email 60×/hour | Renotify → off (transitions only) |
| Partner — Quality aggregated **`count`, not `avg`** — it fired when *nobody voted*, not when satisfaction dropped, and had been stuck ALERT for 11 days (so blind to a real drop) | Aggregation → `avg`; no-data → keep-previous (matching FAQ, per the table above) |

Two things confirmed working and left alone: the `outcome:failed` **tag really is
emitted and filterable** (`lib/langfuse.ts` sets `outcome:${outcome}`; observations
from the 2026-08-13 failure test carry it), and all eight alert env vars are set on
the `navio-widget` Vercel project. A signed synthetic alert to production returned
`{"ok":true,"delivered":{"teams":"sent","email":"sent"}}`.

Still open, deliberately: **both Cost monitors are uncalibrated** — alert at $5/day
against real spend of ~$0.15 per 30 days, so they cannot fire. They need a real
baseline (§ Manual one-time setup step 1). And the **Orchestrator project has no
monitors and no webhook secret** (its relay route correctly answers
`{"skipped":"not configured"}`).

**The lesson worth keeping:** a monitor's `severity` field only proves it
*evaluated*, never that anyone was *told*. The delivery path has its own state —
automation enabled/disabled, and a URL that is just a string nobody validates.
Check `GET /api/public/monitors` for the evaluation half and the project's
**Automations** page for the delivery half; they fail independently.

## ⚠ Live-instance quirks measured, not assumed

1. **Monitors and Alerts are the same feature.** The URL is `/monitors`; the docs and UI say
   "Alerts" interchangeably. GA in self-hosted OSS v4+ with **no alert limits** (Cloud has
   plan-based limits; self-hosted doesn't) — confirmed against this exact v4.6.0 instance.
2. **Webhook signature**: header `x-langfuse-signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over
   `${timestamp}.${rawBody}` — the **raw**, unparsed body. `lib/monitoring/hmac.ts` verifies
   with `crypto.timingSafeEqual`, guarded against a buffer-length mismatch (which throws, not
   returns false) and a stale timestamp (>5 min, replay protection — not documented
   explicitly for Monitors webhooks, but standard practice for this exact scheme).
3. **Langfuse auto-disables an Automation after 5 consecutive delivery failures.** The relay
   therefore always returns 2xx once the signature verifies — a downstream Teams/Graph
   failure is logged loudly but never surfaced as a non-2xx, because a Langfuse retry cannot
   fix a Teams outage, and disabling the *monitor* over a transient blip would create a blind
   spot exactly when it matters. The one deliberate exception is an invalid signature (401) —
   that's a misconfiguration or an attacker, and it's correct for persistent 401s to
   eventually trip the auto-disable there.
4. **Teams "Workflows" webhook** (the modern replacement for retired Office 365 Connectors)
   **requires an Adaptive Card `attachments` envelope — the plain `{"text": ...}` schema
   silently posts nothing.** Measured live 2026-08-21 against the real
   "Webhookbenachrichtigungen an einen Kanal senden" Workflow on the *Navio Alerts* channel:
   a `{"text": ...}` POST returns 202 Accepted but the flow's "send each adaptive card"
   action iterates over `attachments` and finds none, so no message ever appears. The relay
   therefore sends `{type: "message", attachments: [{contentType:
   "application/vnd.microsoft.card.adaptive", content: <card>}]}` (`formatTeamsCard` in
   `lib/monitoring/format-alert.ts`). Note 202 ≠ delivered — it only means the flow was
   triggered. 28 KB message-size limit, throttled beyond 4 requests/sec (irrelevant at this
   volume).
5. **Graph `sendMail` app-only must target `/users/{upn}/sendMail`, never `/me`** — app-only
   auth has no signed-in user. Success is `202 Accepted` with an **empty body** — there is no
   delivery confirmation; treat it as fire-and-forget by design, not a bug to work around.

## Manual one-time setup

### 1. Per Langfuse project (FAQ, Partner, Orchestrator)

1. Pull a real 7-day cost/latency baseline first (dashboard or `queryMetrics`) before setting
   the cost thresholds in the table above.
2. Create each Monitor from the table.
3. Create **one** Webhook Automation, linked from all of that project's monitors. Copy the
   generated secret into `LANGFUSE_ALERT_WEBHOOK_SECRET_<PROJECT>`.
4. Paste the relay's URL into the Automation:
   - FAQ → `https://<navio-widget-domain>/api/monitoring/alerts/faq`
   - Partner → `https://<navio-widget-domain>/api/monitoring/alerts/partner`
   - Orchestrator → `https://<navio-widget-domain>/api/monitoring/alerts/orchestrator`

### 2. Teams

1. Target channel → **···** → **Workflows** → search "webhook" → template
   **"Webhookbenachrichtigungen an einen Kanal senden"** / *"Post to a channel when a
   webhook request is received"*. (NOT the "…von bestimmten Personen / von Personen in
   einer Organisation" variants — those require the caller to be an authenticated Microsoft
   user, which a server webhook is not.) **Done 2026-08-21** for channel *Navio Alerts*.
2. Save, copy the generated webhook URL into `TEAMS_ALERT_WEBHOOK_URL`. The template's
   default flow posts the Adaptive Cards from the request's `attachments` — exactly what
   the relay sends; no flow editing needed.
3. **Add 2–3 co-owners** to the workflow (Workflows app → manage) so it doesn't become an
   orphan flow if one person leaves — Microsoft's own guidance for exactly this risk.

### 3. Microsoft Graph — reuse the existing `navio-chatbot` Azure AD app

Do **not** register a new app; this one is already admin-consented for several Graph
permissions.

1. Azure Portal → App registrations → **navio-chatbot** → API permissions → **Add a
   permission** → Microsoft Graph → **Application permissions** → `Mail.Send` → **Grant
   admin consent**.
2. Certificates & secrets → new client secret → record it immediately (shown once).
3. Set:
   ```
   MS_GRAPH_TENANT_ID=<the tenant id>
   MS_GRAPH_CLIENT_ID=<navio-chatbot's application (client) id>
   MS_GRAPH_CLIENT_SECRET=<the new client secret>
   MS_GRAPH_SENDER_UPN=<mailbox to send alerts from>
   ```
4. **Recommended hardening**: scope the app to only that mailbox via Exchange Online
   `New-ApplicationAccessPolicy` — an unscoped app-only `Mail.Send` grant can send as *any*
   mailbox in the tenant.

### 4. Recipients + deploy

1. `ALERT_EMAIL_TO=` — comma-separated on-call distribution list.
2. Set every var from this section on the `navio-widget` Vercel project and **redeploy** —
   env changes only apply on a new deployment.

**Pre-existing dependency worth flagging, not silently working around:** `navio-widget`'s
Vercel project currently has **no `LANGFUSE_*` vars set at all** (root `CLAUDE.md` §10/§16.7)
— production traffic traces nowhere today, only local dev does. Alerting is only meaningful
once that's wired; it's a known, already-tracked gap, not introduced by this change.

## Env vars

See `.env.example`'s "Monitoring & Alerting" block for the full annotated list. Every var is
independently optional and independently no-op'd:

| Var | Unset behavior |
|---|---|
| `LANGFUSE_ALERT_WEBHOOK_SECRET_{FAQ,PARTNER,ORCHESTRATOR}` | that project's route verifies nothing and no-ops (200, forwards nowhere) |
| `TEAMS_ALERT_WEBHOOK_URL` | Teams delivery skipped; email (if configured) still fires |
| `MS_GRAPH_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_SENDER_UPN` | email delivery skipped; Teams (if configured) still fires |
| `ALERT_EMAIL_TO` | email delivery skipped even if Graph credentials are present |
| `MONITORING_MAX_REQUEST_BYTES` | defaults to 64000 |

## Testing procedure

### Unit tests

```powershell
npm run typecheck
npx vitest run tests/monitoring-hmac.test.ts tests/monitoring-format.test.ts `
  tests/monitoring-teams.test.ts tests/monitoring-graph-mail.test.ts tests/monitoring-relay.test.ts
```

Covers: signature verify (valid/wrong-secret/tampered-body/stale-timestamp/malformed), every
severity→emoji mapping and cross-channel content consistency, HTML-escaping of the Langfuse
payload's own text, idempotency dedup, missing-secret and bad-signature short-circuits (never
reach Teams/email), oversized-payload 413, unrecognized-payload 200-skip, one channel failing
without blocking the other, Graph token caching + concurrent-refresh collapsing +
retry-once-after-401 + no-retry-on-403, Teams retry-once-on-5xx + no-retry-on-4xx.

### Manual/live: synthetic payload

```powershell
npm run dev:ui -- -p 3010
npm run alert:test faq <secret> http://127.0.0.1:3010 WARNING
```

Point `TEAMS_ALERT_WEBHOOK_URL` / `ALERT_EMAIL_TO` at a **test** channel/inbox first —
`scripts/test-alert-webhook.ts` builds a real HMAC-signed synthetic payload and POSTs it;
the honest check is visually confirming the message actually arrived, since a webhook has
no queryable record the way a trace does.

### Manual/live: a real Langfuse-triggered alert (the lowest-blast-radius way to prove the
whole chain, not just the relay)

1. Pick the **volume/heartbeat** monitor on whichever project has the most controllable
   traffic — it can't misfire on real visitor data the way editing a latency/cost threshold
   could.
2. Record its current Alert threshold.
3. Temporarily set it trivially crossable (e.g. count < 1 over 5 minutes).
4. Send one real turn (`npm run live-check`) or just let the window elapse with no traffic.
5. Confirm Teams **and** email both arrive, correctly formatted, and that Langfuse's own
   retry (if any) does not produce a duplicate.
6. **Immediately restore the recorded threshold.** Repeat once per project (FAQ, Partner,
   Orchestrator) after that project's Monitors + Automation are configured.

## Supabase rules (2026-09-15)

A **second, independent alerting path** lives next to the Langfuse-Monitors relay above.
Spec: `docs/superpowers/specs/2026-09-15-navio-alerting-design.md`. It does not read Langfuse
at all — it evaluates threshold rules directly against the monitoring Supabase project's own
`traces` / `errors` / `feedback` data (the tables behind `/monitoring`, spec
`2026-09-14-navio-monitoring-design.md`), on a schedule, and pushes the result to the same
Teams channel and the same Microsoft Graph mailbox. The two paths can coexist: this one covers
Navio's two Supabase-backed agents (FAQ, Partner); the Langfuse relay above still covers all
three Langfuse projects including the Orchestrator, which this path cannot see (it never
writes to the monitoring Supabase).

### What runs where

```
Supabase (monitoring project)
  pg_cron  'navio-alerts-morning' / 'navio-alerts-afternoon'  (05:00 / 13:00 UTC)
       │  select monitoring_call_evaluate('scheduled')
       ▼
  monitoring_call_evaluate()  — reads Vault secrets alert_evaluate_url / alert_evaluate_secret
       │  pg_net.http_post(url, body={slot}, Authorization: Bearer <secret>)
       ▼
navio-widget (Vercel)
  POST /api/monitoring/alerts/evaluate   (bearer auth; unset secret ⇒ 404, wrong ⇒ 401)
       │  lib/monitoring/alerts/evaluate.ts
       ├─ rules.ts     — PURE: decides ok/breached/skipped per rule from the metrics. No I/O,
       │                 no LLM. This is the only place that decides anything.
       ├─ state.ts     — diffs against alert_state → transitions (fired/recovered) + run_slot
       ├─ narrate.ts   — LLM (Azure, 8 s timeout) phrases the decision in German; on any
       │                 failure/timeout/empty/>1200 chars, a deterministic template is used
       │                 instead (narrative_source records which)
       └─ deliver.ts   — builds the Adaptive Card / email from the SAME AlertMessage shape as
                          the Langfuse relay (`lib/monitoring/format-alert.ts`), sends via the
                          EXISTING senders `lib/monitoring/teams.ts` and
                          `lib/monitoring/graph-mail.ts` — no Resend, no SMTP; email is
                          Microsoft Graph `sendMail`, same `navio-chatbot` Azure AD app as above.
```

**Rules decide, the LLM only phrases.** `rules.ts` is pure and untouched by the model; the
honesty invariant that keeps the message text from ever inventing a number lives there, not
in the prompt. `narrate.ts`'s system prompt explicitly forbids using any number not present in
the JSON it's given, but the belt-and-braces guarantee is structural: the Adaptive Card's
fact list (`Wert` / `Grenze` / `Fenster` / `Turns`) is built directly from the observation in
`deliver.ts`, never from the narrative text — a bad sentence can never hide the real value.
**A dry run (`dryRun:true`) still calls the LLM** — narration happens before the dry-run branch
returns, so a `/monitoring/alerts` preview shows the real wording, not a placeholder; it just
skips writing `alert_state`/`alert_events` and skips delivery.

### The 7 rules

Seeded once, editable per row in `/monitoring/alerts` → Regeln (`alert_rules`, unique on
`key, agent`; re-applying the migration's seed is `on conflict do nothing`, so edited
thresholds are never reset):

| key | agent | severity | threshold | window | min_samples | notes |
|---|---|---|---|---|---|---|
| `cost_daily` | all | alert | 2.00 $ total (1.50 $ per agent) | since Berlin midnight | 0 | `params.per_agent_usd` overrides the total for `faq`/`partner` |
| `cost_spike` | all | warning | 3.0× the 7-day baseline | 24 h | 0 | skipped ("Aufwärmphase") until 7 full baseline days exist; never fires below `min_abs_usd` (0.5 $) |
| `failure_rate` | all | alert | 10 % | 24 h | 10 | `failed` + abandoned (`running` older than 5 min) over all traces |
| `latency_p95` | faq | warning | 8000 ms | 24 h | 10 | |
| `latency_p95` | partner | warning | 60000 ms | 24 h | 10 | |
| `negative_feedback` | all | warning | 30 % | 168 h | 5 | 👎 over rated turns |
| `error_repeat` | all | warning | 5 (count) | 24 h | 0 | per `errors.type`, each type its own `alert_state` row (`subkey`); excludes `upstream_unavailable` (owned by `partner_upstream`) |
| `partner_upstream` | partner | alert | 3 (count) | 24 h | 0 | `errors.type = upstream_unavailable` on partner traces |

`agent = 'all'` rules evaluate once per `faq`, `partner` **and** `total`, each its own
`alert_state` row — so `cost_daily` can fire for the total while both agents individually stay
under their per-agent figure, or vice versa. Rules are always evaluated **production traffic
only** (`traces.metadata->>'env' = 'production'`); local/preview traffic never triggers a rule.

### Notify policy

**On transition only, never while steady.** A rule fires a Teams card + email the moment it
crosses `ok → breached`, and again the moment it crosses `breached → ok` (`recovered`). While
it stays breached across runs, nothing is sent again — `alert_state` is the memory that makes
this idempotent; only `state.ts`'s diff decides whether an observation is a transition.

**The digest is written on every run, sent to Teams only on scheduled + enabled.** Every
evaluation — `scheduled`, `test`, or `manual` (a Regeln-tab "Jetzt auswerten" click) — inserts
one `alert_events` row of `kind = 'digest'` summarising every rule's status, keyed by
`run_slot` (`on conflict do nothing`, so a slot is written at most once). It is only actually
**delivered** to Teams when `slot = 'scheduled'` **and** `alert_settings.digest_enabled` is
true — so the 5-minute test cadence, a manual "Jetzt auswerten", or a preview never floods the
channel, but every run still leaves a row in the Feed tab. The digest never goes to email.

### Vault secrets and `ALERT_EVALUATE_SECRET`

The evaluate URL and its bearer secret are **never in migration text** — they live in Supabase
Vault, read inside `monitoring_call_evaluate()`:

| Vault secret name | Value |
|---|---|
| `alert_evaluate_url` | `https://navio-widget.vercel.app/api/monitoring/alerts/evaluate` |
| `alert_evaluate_secret` | must equal Vercel's `ALERT_EVALUATE_SECRET` on `navio-widget` |

If either is missing, `monitoring_call_evaluate()` raises a notice and returns without
calling out — cron calls are harmless, not a hard failure, until both secrets exist. On the
Vercel side the same value must be set as the env var `ALERT_EVALUATE_SECRET` — **as of this
task it is set on production but not yet on preview**; the owner adds preview by hand
(`vercel env add ALERT_EVALUATE_SECRET preview --sensitive`) since sensitive vars can only be
set interactively, never read back.

### The DST caveat

`pg_cron` runs in UTC with no timezone support, and the two production schedules
(`0 5 * * *` / `0 13 * * *`) are written for **summer time** — 07:00 / 15:00 CEST (UTC+2).
Once Central Europe returns to CET (UTC+1) the same UTC crontab lands at 08:00 / 16:00 local,
one hour late. Wintertime precision is not a requirement (spec: "two digests a day at roughly
7 and 15 o'clock"), but to keep it accurate, shift both jobs by one hour at the DST boundary:

```sql
select cron.alter_job(job_id, schedule := '0 6 * * *')   -- navio-alerts-morning, winter
  from cron.job where jobname = 'navio-alerts-morning';
select cron.alter_job(job_id, schedule := '0 14 * * *')  -- navio-alerts-afternoon, winter
  from cron.job where jobname = 'navio-alerts-afternoon';
```

(and the reverse, back to `0 5` / `0 13`, at the spring boundary). Nothing automates this yet;
it is a twice-yearly manual step, worth a calendar reminder once this ships.

### Reading the scheduler's own logs

`cron.job_run_details` is the per-run record of the `pg_cron` job itself (start/end time,
`succeeded`/`failed`, the job's own error if the function raised); `net._http_response` is the
**separate** async result of the `pg_net.http_post` call the function issued — a `pg_cron` run
can show `succeeded` (the function returned) while the HTTP call inside it later resolves to a
non-200 in `net._http_response`, so check both:

```sql
-- last 5 runs of each alerting job
select j.jobname, r.status, r.start_time, r.end_time, r.return_message
from cron.job_run_details r join cron.job j on j.jobid = r.jobid
where j.jobname like 'navio-alerts-%'
order by r.start_time desc limit 10;

-- the actual HTTP result the function's net.http_post produced
select id, status_code, content, created
from net._http_response
order by created desc limit 10;
```

A `status_code = 200` with a JSON body containing `"ok":true` is the honest proof the widget
was reached and evaluated; a `pg_cron` "succeeded" row alone only proves the SQL function
didn't raise.

### Env / Vault summary

| Name | Where | Purpose |
|---|---|---|
| `ALERT_EVALUATE_SECRET` | Vercel `navio-widget` env (production ✅, preview: owner to add) | bearer secret the evaluate route checks; unset ⇒ route returns 404 (feature off) |
| `alert_evaluate_url` | Supabase Vault (monitoring project) | the evaluate route's URL, read by `monitoring_call_evaluate()` |
| `alert_evaluate_secret` | Supabase Vault (monitoring project) | must match `ALERT_EVALUATE_SECRET` above |
| `TEAMS_ALERT_WEBHOOK_URL` | existing (shared with the Langfuse relay) | unset ⇒ Teams delivery skipped, recorded as `skipped` on the event |
| `MS_GRAPH_*` | existing (shared, `navio-chatbot` app, `Mail.Send`) | unset ⇒ email skipped; this is Microsoft Graph `sendMail`, **not Resend, not SMTP** |
| `ALERT_EMAIL_TO` | existing | fallback recipients when `alert_settings.email_recipients` is empty |
| `AZURE_AI_CHATBOT_*` | existing | narration model; unset/timeout/failure ⇒ template fallback, never a thrown error |

### Go-live checklist

The test cadence (`navio-alerts-test`, every 5 minutes, migration
`20260915000200_alerting_cron.sql`) is applied and running today, evaluating against
`navio-widget`'s **`main`** deployment — which does not yet have the `/api/monitoring/alerts/*`
routes, since they only exist on this `alerting` branch. **Every step below is therefore for
the owner to run manually, after this branch merges to `main` and `navio-widget` redeploys —
none of it was executed as part of this task**, per its scope limits (write the production
migration, do not apply it; do not unschedule the test job; no Vercel/Vault/Supabase state
changes).

1. Confirm `ALERT_EVALUATE_SECRET` is set on Vercel `navio-widget` for **both** production and
   preview (sensitive, write-only — rotate rather than "find" it if in doubt), and that it
   equals the Supabase Vault secret `alert_evaluate_secret`.
2. Merge `alerting` to `main`; wait for `navio-widget` to redeploy. Confirm the endpoint exists
   and authenticates:
   ```
   curl -X POST https://navio-widget.vercel.app/api/monitoring/alerts/evaluate \
     -H "Authorization: Bearer <ALERT_EVALUATE_SECRET>" \
     -d '{"slot":"manual","dryRun":true}'
   ```
   expect `ok:true` in the response.
3. Confirm the existing `navio-alerts-test` cron job is actually reaching that deployment —
   `net._http_response` shows `status_code = 200` for a recent call (see the queries above).
4. Apply `supabase/migrations/20260915000300_alerting_cron_production.sql` (schedules
   `navio-alerts-morning` / `navio-alerts-afternoon`, unschedules `navio-alerts-test`).
   Confirm: `select jobname from cron.job;` lists exactly the morning and afternoon jobs, no
   test job.
5. Set real recipients in the dashboard: `/monitoring/alerts` → Regeln → Empfänger.
6. Next morning: confirm the 07:00 digest landed in the Navio Alerts Teams channel and shows
   in the Feed tab with `run_slot` matching `<date>T07`.

### Verifying the loop live

`npm run alerts:verify` (`scripts/alerts-verify.ts`) proves the whole path against a **running
widget** and the real monitoring Supabase, without waiting for a scheduled run: it seeds a
batch of failed, `env: production`-tagged traces under a throwaway session, calls `evaluate`
(`slot: "manual"`) and asserts a `fired` transition for `failure_rate · faq`, marks the same
traces `completed` and asserts `recovered`, calls a third time and asserts no further
transition and that a `manual`/`test` slot never sends the digest, then deletes its throwaway
session, traces and `alert_state` row. **It intentionally posts one red (breach) and one green
(recovery) card to the real Navio Alerts Teams channel** — that is the only honest way to
prove delivery, since a webhook/Graph send has no queryable record the way a trace does — and
cleans up its own rows afterwards so it leaves no stray data behind.

## What it answers

Once live: which agent's cost/latency/error rate moved out of range, when, by how much, and
a direct link to the trace — without anyone needing to be staring at a dashboard. Joined
against the existing feedback system (`docs/FEEDBACK-SYSTEM.md`): a quality-threshold breach
and a spike in 👎 votes are two views of the same regression, one automatic, one human-sourced.
The Supabase-rules path above adds the same answer for FAQ and Partner without depending on
Langfuse being wired on `navio-widget` at all — which matters today, since (root `CLAUDE.md`
§16.7) production traffic there still has no `LANGFUSE_*` vars set.
