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

## What it answers

Once live: which agent's cost/latency/error rate moved out of range, when, by how much, and
a direct link to the trace — without anyone needing to be staring at a dashboard. Joined
against the existing feedback system (`docs/FEEDBACK-SYSTEM.md`): a quality-threshold breach
and a spike in 👎 votes are two views of the same regression, one automatic, one human-sourced.
