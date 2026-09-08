# Navio feedback — the quality loop

👍/👎 on every assistant answer, written as Langfuse **scores** onto the exact
trace that produced the answer — and, since **2026-09-08**, wired into a full
improvement loop instead of stopping at collection:

```
COLLECT           REVIEW                     ANALYZE            IMPROVE                EVALUATE
👍/👎 + reason  →  annotation queues       →  feedback:report →  prompt / KB / data  →  datasets via
+ comment          + review-verdict score     (weekly)           change                feedback:promote
     └────────────────────────────── positive rate by knowledge.version_digest closes the loop ─────────┘
```

Collection built and verified live 2026-08-18; loop redesign (positive queue,
review verdicts, report/promote scripts, config cleanup) 2026-09-08.

## What a visitor sees

Thumbs appear under an answer once it is **complete**. Either thumb is recorded
**immediately**; a panel then offers enrichment — 👎 gets eight reasons plus an
optional comment, 👍 gets just the comment box ("Was war gut?"). The panel is
never a gate: a form that only submits at the end loses every visitor who does
not finish it.

## Data model

One source of truth for the whole vocabulary: **`lib/feedback-taxonomy.ts`**
(client-safe, imported by the widget component, the server, the scripts and the
tests — the reason list used to exist twice and drift).

| Score | Type | Values | Written by |
|---|---|---|---|
| `user-feedback` | NUMERIC 0–1 | `1` = 👍, `0` = 👎; visitor comment in the score's `comment` | the widget, both thumbs |
| `feedback-reason` | CATEGORICAL | `too_slow · not_relevant · incorrect · unclear · unanswered · tool_failed · misunderstood · other` | the widget, 👎 only |
| `review-verdict` | CATEGORICAL | `good-example · incorrect · partially-correct · unclear-question · ux-issue · data-gap · other` | **a human**, from inside the annotation queues |

NUMERIC for the thumb because its **average is the satisfaction rate**. Each
reason code carries a `correlate` hint in the taxonomy — the objective trace
metric that should agree with the subjective complaint (e.g. `too_slow` ↔
`timing.duration_ms`). `feedback:report` prints these next to the histogram.

Score ids are deterministic (`fb-{session}-{turn}`), so a re-vote **updates**
the row and a retry is idempotent.

## Routing into the queues

| Event | Goes to |
|---|---|
| every 👎 | queue **"Feedback — Negative Review"** (`LANGFUSE_FEEDBACK_QUEUE_ID`) |
| 👍 **with a comment** | queue **"Feedback — Positive Examples"** (`LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID`) |
| plain 👍 | statistics only; `feedback:report` samples ~5/week for spot review |

Both pushes dedupe by **asking the queue** (Langfuse does not dedupe items
itself, and the file-backed marker is per-instance — measured: five identical
production POSTs made two items before this), with the marker as a fast path.
Unset queue env ⇒ silent no-op, scores still written. A 👎→👍 flip deliberately leaves the queue item alone — "flagged, then
reconsidered" is signal a reviewer should see.

## The rituals

**Daily (~10 min):** Langfuse UI → Annotation Queues → **Feedback — Negative
Review** → filter PENDING. Each item opens next to its trace; read the visitor's
`feedback-reason` + comment, check the reason's correlate metric on the trace,
set **one `review-verdict`**, optionally leave a Comment, mark **COMPLETED**.
Do the same for **Feedback — Positive Examples** (usually much shorter).

**Weekly:**
0. `npm run feedback:reconcile` — upgrades any session-precision votes to
   their trace now that ingestion has caught up (see "How feedback finds the
   right trace").
1. `npm run feedback:report` — totals, positive rate + trend, reason and
   verdict histograms, environment split, positive rate per
   `knowledge.version_digest`, pending counts, the plain-👍 sample.
2. Spot-review the sampled plain 👍; a model answer deserves a queue item in
   Positive Examples (create it in the UI from the trace) with verdict
   `good-example`.
3. `npm run feedback:promote` (`-- --dry-run` first if unsure) — COMPLETED
   items become dataset entries:
   `good-example` → **"Feedback — Golden Answers"**,
   `incorrect`/`partially-correct` → **"Feedback — Regressions"**.
   Other verdicts route to work, not datasets: `data-gap` → fix directory/KB,
   `ux-issue` → widget backlog, `unclear-question` → no agent defect.

**The improvement recipe:** pick the biggest verdict/reason cluster → change
the prompt / KB / data accordingly → after deploying, compare the
digest-grouped positive rate in `feedback:report` (a prompt change changes
`knowledge.version_digest`, so before/after separate cleanly) → run the
Regressions dataset through the eval harness before calling it fixed.

## Environment ids (per project — the env pair selects the project)

| Variable | FAQ (`navio-widget`) | Partner (`navio-partner`) |
|---|---|---|
| `LANGFUSE_FEEDBACK_SCORE_CONFIG_ID` | `ed137b20-ae08-408d-af70-a6816a91948f` | `5e7b44aa-68be-4480-bcbb-e4dd052d8c5e` |
| `LANGFUSE_REASON_SCORE_CONFIG_ID` | `038c8214-eef0-4c18-9ea3-ce320b921c91` | `b48f093f-8f88-4a9b-9ca8-b53d050ba407` |
| `LANGFUSE_REVIEW_VERDICT_CONFIG_ID` | `59585208-8f5a-40b3-81d7-5a620f58ef04` | `fcba756c-091b-49ea-88ab-cfbb2c49a227` |
| `LANGFUSE_FEEDBACK_QUEUE_ID` | `cmtss8ozw00tkqe07hddgygpu` | `cmtssafjq00ulqe07v7daa29t` |
| `LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID` | `cmtss8p7500tnqe07liw170ni` | `cmtssaflz00uoqe07wsz0646j` |

Set in `.env.local` **and** on the Vercel project (env change ⇒ redeploy).
`npm run feedback:setup` regenerates/validates all of this idempotently and
prints the lines — it picks the earliest **well-formed** config per name
(the FAQ project's oldest `user-feedback` config is malformed, null min/max —
now archived along with the other duplicates, 2026-09-08).

## Scripts

| Command | Does |
|---|---|
| `npm run feedback:setup` | idempotent: ensures 3 configs + 2 queues, migrates legacy queue items, prints env ids |
| `npm run feedback:check` | reads recent scores back (sanity) |
| `npm run feedback:reconcile [-- --dry-run]` | session-precision votes → trace precision, once ingested |
| `npm run feedback:report [-- --days 14]` | the weekly statistics (see rituals) |
| `npm run feedback:promote [-- --dry-run]` | COMPLETED + verdict → datasets, idempotent per trace |

Pure computation lives in `lib/feedback-insights.ts` (tested offline in
`tests/feedback-insights.test.ts`); the scripts are thin I/O.

## How feedback finds the right trace

The browser knows only `sessionId` + `turnId`. The server resolves the trace in
three steps (`resolveTarget` in `app/api/feedback/route.ts`):

1. **Local map** `feedbackRefs`, written by the Langfuse hook at turn end —
   dev, or the lucky warm instance. On Vercel it lives under
   `/tmp/navio-langfuse` (`STORE_ROOT`; `.data/` is read-only there).
   **Measured 2026-09-08: 0 of 5 production votes found it** — the invocation
   serving `/api/feedback` is almost never the one that finished the turn.
2. **Ask Langfuse** (`resolveTraceViaLangfuse`): one read of the session's
   observations; the session's traces ordered by start time ARE the turn
   order, so `turn_N` → the N-th trace (`traceForTurn`). No local state, so it
   works on any instance — as soon as at least one span of that turn has been
   ingested.
3. **Session precision** as the last resort, never nothing: a vote cast within
   seconds of the answer can beat ingestion. The response reports
   `precision: "trace" | "session"`.

**`npm run feedback:reconcile`** upgrades step-3 votes later: it resolves the
trace the same way, then **deletes and re-creates** each score with the same
id (the API cannot move a score's subject — a merge POST keeps the old
subject, measured), keeping the vote's real time in
`metadata.originalTimestamp` (honoured by the statistics), and replaces the
PENDING `SESSION` queue item with a `TRACE` one. Run it before the weekly
report. Idempotent.

Partner votes are forwarded (service 1 cannot resolve a partner trace):
`FAQ screen → /api/feedback → Navio — FAQ` ·
`Partner screen → /api/feedback → service 2 /api/feedback → Navio — Partner`
(loopback/shared-secret gated).

## ⚠ Live-instance behaviour (measured — do not re-learn)

1. **Score reads only work on `/api/public/v3/scores`** (`/scores`, `/v2` 404).
   `fields=details` for `comment`/`metadata`, **`fields=subject`** for the
   trace/session linkage — v3 rows have NO `traceId`; it is
   `subject: {kind, id}`, and a categorical score's label is in `value`
   (`lib/feedback-insights.ts` `fromV3Row` normalizes). Pagination is by
   `meta.cursor`; a `page` param is a 400.
2. **Re-POSTing the same score `id` updates in place, but as a PARTIAL MERGE.**
   Always send every field; `comment: ""` clears. A categorical score has no
   "none" — retract with DELETE (202). **The subject cannot be moved by a
   merge** (session stays session); DELETE + re-create with the same id does
   move it — that is what `feedback:reconcile` does.
3. **Langfuse silently creates duplicate configs/queues on create** — all setup
   is list-then-create. Score configs **can** be updated/archived via
   `PATCH /api/public/score-configs/{id}` (verified 2026-09-08; the MCP tool's
   update exposes description/categories but not `isArchived`). Annotation
   queues have **no update or delete API** — a wrongly named queue is permanent
   until removed in the UI.
4. **REST config field names differ from the MCP tool's** (`categories`/
   `minValue`/`maxValue` vs `categoricalCategories`/`numericMinValue`/…).
5. Creating a queue with `scoreConfigIds: []` is rejected — the field must be
   non-empty.
6. **PowerShell 5.1 `Get-Content`/`Set-Content` without `-Encoding` mangles
   UTF-8** (em-dashes → `â€”`). Two mojibake-named queues in the Partner project
   (created 2026-09-08, emptied since) exist because of this; delete them in the
   UI when convenient. Edit source files with byte-safe tools.

## Legacy

The pre-2026-09-08 queue "Negative Feedback Review" (both projects) is retired
in place: PENDING items were migrated to "Feedback — Negative Review" (skipping
duplicates, flipped-👍 traces and one bogus OBSERVATION item), and it should be
ignored going forward. `scripts/setup-feedback-scores.ts` is superseded by
`setup-feedback-workflow.ts`.

## Monitor checklist (manual — no monitor-update API)

- [ ] Partner project · Quality monitor: aggregation **avg** of `user-feedback`, not count (was false-alarming for 10 days)
- [ ] FAQ project · latency p95 monitor: filter to observation `answer-delivered`
- [ ] FAQ project · heartbeat monitor: unpause

## Privacy

Sent: anonymous session id, turn id, thumb, reason code, optional comment.
Not sent: IP, user agent, user id. Comments are volunteered, so they are **not**
gated behind `LANGFUSE_RECORD_IO` — disable with `NAVIO_FEEDBACK_ALLOW_TEXT=false`.
