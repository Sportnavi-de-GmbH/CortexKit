# Navio feedback — dashboard and review workflow

👍/👎 on every assistant answer, written as Langfuse **scores** onto the exact
trace that produced the answer, feeding one dashboard and one review queue:

```
visitor 👍/👎 (+ reason, comment)
      │
      ├──▶ scores on the trace ──▶ "Navio Health" dashboard (counts, rates, cost, speed)
      │
      └──▶ Review queue ──▶ human picks ONE verdict ──▶ feedback:promote ──▶ datasets
               👎 always            good-example → Golden Answers      (eval / regression
               👍 with comment      wrong-answer → Regressions          runs before a
                                    data-gap / not-a-defect → no dataset  prompt change)
```

Collection built 2026-08-18; loop redesign 2026-09-08; dashboard + 4-verdict
review workflow 2026-09-09.

---

## 1. The dashboard — "Navio Health"

One per Langfuse project (FAQ, Partner), identical layout. Reading order is
top-left to bottom-right; every tile answers one question.

| Row | Tiles (left → right) | Question answered |
|---|---|---|
| 1 | **Requests** · **Failed turns** · **Cost (USD)** (table: total + avg per call) · **Avg turn latency** | Is it running, breaking, expensive, slow? |
| 2 | **Answers rated** · **👍 Positive feedback** · **👎 Negative feedback** · **Positive rate (0–1)** | Are people voting, and how? |
| 3 | **Requests per day** (bars) · **Feedback split** (pie, % of 👍 vs 👎) | Trend, and the rates as percentages |

- **Requests with no feedback = Requests − Answers rated.** The two tiles sit
  vertically adjacent for exactly this reason; Langfuse dashboards have no
  computed tiles.
- **Negative rate = 1 − Positive rate**, and both are on the pie as percentages.
- **Requests** counts the per-turn `answer-delivered` span (one per visitor
  turn). Never the trace root — it also fires on eve's internal HTTP calls and
  over-counted ~20× (measured: 532 roots for 30 turns; 132 for 6).
  **Since 2026-09-09 those session-less roots are no longer exported** (the
  root only ships when its trace carried a visitor turn), so the Tracing list
  and the dashboard agree: one trace per request. Roots from before that date
  remain in the Tracing list as empty `visitor-request` rows.
- **Failed turns** is the one extra health tile: `answer-delivered` with
  `outcome = failed`. It is the only number that should always be 0.
- **Cost is a small table, not a big number, on purpose.** Langfuse's number
  tile formats currency to whole dollars, so a day of Navio traffic
  ($0.013 for 6 calls) renders as "$0"; time-series axes round to cents and
  show "$0.00" too. The table shows full precision ($0.013052 total,
  $0.002175 per call). Seen in a real browser 2026-09-09.
- **Avg turn latency** is end-to-end (visitor message → delivered answer);
  Langfuse formats it in seconds ("4 s").
- **Date range:** the dashboard has no stored default — the picker remembers
  your last choice. Use **Last 7 days** for a health check, **30 days** for
  trends.

Definitions were validated against the metrics API before placement (FAQ, 14
days: 30 requests = 30 billed calls, 0 failed, $0.06, 3.8 s avg; 9 votes 6👍/3👎).

Not on the dashboard, on purpose: reason breakdowns, verdict breakdowns,
digest comparisons, token splits. `npm run feedback:report` prints those when
you are investigating rather than checking.

---

## 2. The review workflow

### What a reviewer sees, and what they do (≈ 60 seconds per item)

1. Langfuse → **Annotation Queues** → **Review: negative feedback** → filter
   *Pending* → open the first item.
2. The trace opens beside the annotation panel. Read **the question** (trace
   name) and **the answer** (output). In the trace's **Scores** panel:
   `user-feedback` = the visitor's thumb, its **comment** = their own words,
   `feedback-reason` = the code they picked (why they were unhappy).
3. Pick **one `review-verdict`** — the only field in the panel:

   | Verdict | Choose when | What happens next |
   |---|---|---|
   | `good-example` | the answer is genuinely a model response | promoted to dataset **Feedback — Golden Answers** |
   | `wrong-answer` | wrong or misleading in **any** part (facts, missing key info, wrong partner) | promoted to dataset **Feedback — Regressions** |
   | `data-gap` | the answer is fine, but our directory / KB lacks the information | fix the **data**, not the prompt |
   | `not-a-defect` | vague question, speed/UX complaint, visitor error, nothing to change | nothing |

4. Optional: leave a **Comment** on the trace only when the verdict alone would
   not tell the next person what you saw.
5. Mark **Complete**. Next item.

**Mandatory:** the verdict. **Not needed:** re-rating the visitor's reason,
scoring anything else, writing a summary.

### Positive examples

Only 👍 votes **with a visitor comment** enter **Review: positive examples**
(plain 👍 stays statistics-only; `feedback:report` samples ~5/week for a spot
check). Verdict is `good-example` (→ golden dataset) or `not-a-defect`
(nothing special). Complete.

### From reviewed items to datasets

`npm run feedback:promote` reads every **Completed** item, joins its
`review-verdict`, and upserts `good-example` traces into **Feedback — Golden
Answers** and `wrong-answer` traces into **Feedback — Regressions**
(input = the question, expected output = the answer, metadata = verdict +
`knowledge.version_digest`). Idempotent per trace; `-- --dry-run` previews.
Run the Regressions dataset through the eval harness before shipping a prompt
or KB change; compare the digest-grouped positive rate after.

### Why the 2026-09-08 queues were replaced

They attached the visitor's `feedback-reason` config as well, which showed
reviewers a second, empty dropdown they were not supposed to fill. Queues
cannot be edited, so the current pair attaches **only `review-verdict`**, and
the verdict vocabulary shrank from 7 values to the 4 above (finer distinctions
never changed the follow-up action). Retired queues cannot be deleted via API:
they were emptied — remove them in the UI when convenient.

---

## 3. Weekly (10 minutes)

0. `npm run feedback:reconcile` — upgrades any session-precision votes to
   their trace now that ingestion caught up (§5).
1. `npm run feedback:report` — totals, trend, reason histogram, verdicts,
   positive rate per `knowledge.version_digest`, queue backlog, plain-👍 sample.
2. Clear the two queues (§2).
3. `npm run feedback:promote`.

---

## 4. Data model

One source of truth for the vocabulary: **`lib/feedback-taxonomy.ts`**
(client-safe; imported by the widget component, the server, the scripts, tests).

| Score | Type | Values | Written by |
|---|---|---|---|
| `user-feedback` | NUMERIC 0–1 | `1` = 👍, `0` = 👎; visitor comment in `comment` | the widget, both thumbs |
| `feedback-reason` | CATEGORICAL | `too_slow · not_relevant · incorrect · unclear · unanswered · tool_failed · misunderstood · other` | the widget, 👎 only |
| `review-verdict` | CATEGORICAL | `good-example · wrong-answer · data-gap · not-a-defect` | a human, from the queue |

Score ids are deterministic (`fb-{session}-{turn}`): a re-vote updates the row,
a retry is idempotent. Each reason code carries a `correlate` hint (the trace
metric that should agree with it); `feedback:report` prints it.

### Environment ids (the env pair selects the project)

| Variable | FAQ (`navio-widget`) | Partner (`navio-partner`) |
|---|---|---|
| `LANGFUSE_FEEDBACK_SCORE_CONFIG_ID` | `ed137b20-ae08-408d-af70-a6816a91948f` | `5e7b44aa-68be-4480-bcbb-e4dd052d8c5e` |
| `LANGFUSE_REASON_SCORE_CONFIG_ID` | `038c8214-eef0-4c18-9ea3-ce320b921c91` | `b48f093f-8f88-4a9b-9ca8-b53d050ba407` |
| `LANGFUSE_REVIEW_VERDICT_CONFIG_ID` | `59585208-8f5a-40b3-81d7-5a620f58ef04` | `fcba756c-091b-49ea-88ab-cfbb2c49a227` |
| `LANGFUSE_FEEDBACK_QUEUE_ID` (Review: negative feedback) | `cmttxoqbg011iqe07zpff7onj` | `cmttxot7p011oqe07ff8ir9tg` |
| `LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID` (Review: positive examples) | `cmttxorrv011lqe072vwu6xmr` | `cmttxoupr011rqe07fh2mz43b` |

Set in `.env.local` **and** on the Vercel project (env change ⇒ redeploy).
`npm run feedback:setup` validates/creates all of it idempotently and prints
the lines. Scripts identify the queues by these ids, never by name.

### Scripts

| Command | Does |
|---|---|
| `npm run feedback:setup` | idempotent: 3 configs + 2 queues, migrates retired queues, prints env ids |
| `npm run feedback:check` | reads recent scores back (sanity) |
| `npm run feedback:reconcile [-- --dry-run]` | session-precision votes → trace precision, once ingested |
| `npm run feedback:report [-- --days 14]` | the weekly statistics |
| `npm run feedback:promote [-- --dry-run]` | Completed + verdict → datasets |

Pure computation lives in `lib/feedback-insights.ts` (tested offline).

---

## 5. How feedback finds the right trace

The browser knows only `sessionId` + `turnId`. `resolveTarget` in
`app/api/feedback/route.ts`:

1. Local `feedbackRefs` map (dev / warm instance). **Measured: 0 of 5
   production votes found it** — Vercel rarely serves `/api/feedback` from the
   instance that ran the turn.
2. **Ask Langfuse** (`resolveTraceViaLangfuse`): a session's traces ordered by
   start time ARE the turn order, so `turn_N` → the N-th trace. Works on any
   instance once one span of the turn is ingested. Verified in production:
   5 of 5 votes at trace precision, one queue item for five identical POSTs.
3. Session precision as last resort (a vote seconds after the answer can beat
   ingestion). `feedback:reconcile` upgrades those later by DELETE + re-create
   with the same id (a merge cannot move a score's subject), keeping the real
   vote time in `metadata.originalTimestamp`.

Queue pushes dedupe by **asking the queue** (Langfuse does not; per-instance
markers made 2 items from 5 POSTs). Partner votes are forwarded to service 2's
own `/api/feedback` (it owns those traces), loopback/shared-secret gated.

### Retraction and flips — Langfuse mirrors the current vote (2026-09-09)

- **Retraction** (second click on the same thumb) posts `thumb: null`. The
  server DELETEs both scores by their deterministic ids and removes the
  vote's PENDING queue item(s). Until 2026-09-09 the widget only reset its own
  UI, so Langfuse kept a vote the visitor had withdrawn — the dashboard counted
  it and the review queue showed it.
- **Flips move the item.** 👎 → pending in the negative queue, nothing in the
  positive one; 👍 with comment → the reverse; plain 👍 → in neither. The
  earlier "a flip leaves the item" rule is gone: it left reviewers opening 👎
  items whose visitor had since said 👍.
- Removal looks for the item under the trace **and** the session, so a vote
  that was queued at session precision is still found once the retraction
  resolves to the trace. **COMPLETED items are never touched** — a review that
  happened is a fact.
- **A score DELETE is asynchronous and slow — 202 on enqueue, the row
  disappears when Langfuse's background ClickHouse mutation runs: measured
  2 minutes for the first retraction of the day and 4–10+ minutes once
  several deletes were queued (mutations are serialized).** A re-vote that
  reused the same id inside that window was wiped when the delete finally
  landed (seen live: a 👍 cast a few minutes after a retraction vanished). So
  the widget keeps a per-answer **epoch** that increments on every
  retraction, and the score id becomes `fb-{session}-{turn}-e{epoch}` for
  epoch ≥ 1 — a pending delete of epoch N can never touch epoch N+1. Flips
  are updates of the same id and need no epoch bump. Verified in production:
  👎 → retract → 👍 two seconds later; the epoch-0 rows were deleted minutes
  later and the epoch-1 👍 survived.
- **Renaming a score instead of deleting it is NOT a faster retraction**: a
  same-id upsert with a new name is reflected on the by-id read within
  seconds, but the analytics view kept counting it under the OLD name four
  minutes later (and the name-filtered list showed both). Measured, rejected.
- **What "reflected in Langfuse" means for a removal:** the review-queue item
  disappears at once (item DELETE is synchronous); the score — and therefore
  the "Answers rated" / 👍 / 👎 tiles — follows when the mutation runs, minutes
  later. Adds and flips are visible in the scores API within ~15 s and on the
  dashboard within about a minute.
- Every queue push/removal failure is now logged (shape only: queue id,
  object type, status) and every accepted vote logs one `FEEDBACK ok:` line
  (thumb, epoch, precision, comment length) — so the Vercel log tells a turn's
  whole feedback story without visitor text.

### What "in sync" means here (eventual consistency, measured)

Langfuse is not a transactional database. Scores POST/DELETE are acknowledged
on enqueue and become readable within seconds; spans arrive via OTLP batches
and the last invocation's spans of a turn can take ~1–2 minutes to become
queryable; **deleting a trace in the UI** removes its observations, scores and
queue items asynchronously. So immediately after any write, a dashboard tile
can lag by a minute — that is ingestion, not staleness or caching. There is
no application-side cache: every tile is a live ClickHouse query and every
script reads the API fresh.

---

## 6. Live-instance behaviour (measured — do not re-learn)

1. **Score reads: `/api/public/v3/scores` only**, cursor-paged (`meta.cursor`; a
   `page` param is a 400). `fields=details` for `comment`/`metadata`,
   **`fields=subject`** for the trace/session link — rows have no `traceId`; a
   categorical label is in `value`. `fromV3Row` normalizes.
2. **Same-id POST is a PARTIAL MERGE** — send every field; `comment: ""`
   clears. Categorical has no "none": DELETE (202). **A merge cannot move the
   subject**; DELETE + re-create does.
3. **Configs**: list-then-create (Langfuse duplicates silently); `PATCH
   /score-configs/{id}` accepts `isArchived`, `description`, `categories`
   (the 7→4 verdict change and the FAQ duplicate archive used it).
4. **Queues**: no update, no delete, no rename; items are not deduped;
   `scoreConfigIds` must be non-empty. Item create/delete works.
5. **Dashboards** (API): views are observations / scores-*; no traces view, no
   computed tiles; filter column for score name is `name`; score `value` is
   both a filter (`type: "number"`) and a pie dimension. **NUMBER tiles round
   currency to whole dollars and time-series axes to cents** — use a
   PIVOT_TABLE for sub-dollar cost. Latency NUMBER tiles auto-format ms → s.
6. **Deleting a trace deletes its scores and queue items** — test traces you
   remove disappear from every count (this explains any "missing votes").
7. PowerShell 5.1 `Get-Content`/`Set-Content` without `-Encoding` mangles UTF-8
   (the two `Feedback â€” …` queues in the Partner project came from that;
   delete them in the UI).

## 7. Privacy

Sent: anonymous session id, turn id, thumb, reason code, optional comment.
Not sent: IP, user agent, user id. Comments are volunteered, so they are not
gated behind `LANGFUSE_RECORD_IO` — disable with `NAVIO_FEEDBACK_ALLOW_TEXT=false`.
