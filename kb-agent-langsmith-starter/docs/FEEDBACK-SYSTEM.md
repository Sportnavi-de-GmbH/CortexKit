# Navio user feedback → Langfuse

👍/👎 on every assistant answer, with an optional reason and comment, written as
Langfuse **scores** onto the exact trace that produced the answer.

Built and verified live 2026-08-18 (FAQ + Partner screens).

## What a visitor sees

Thumbs appear under an answer only once it is **complete**. A 👎 is recorded
**immediately**, then a panel offers eight reasons and an optional comment. The
panel is enrichment, never a gate — a form that only submits at the end loses
every visitor who does not finish it, and those are the annoyed ones whose
signal matters most.

## Data model

| Score | Type | Value | When |
|---|---|---|---|
| `user-feedback` | NUMERIC 0–1 | `1` = 👍, `0` = 👎 | always |
| `feedback-reason` | CATEGORICAL | `too_slow`, `not_relevant`, `incorrect`, `unclear`, `unanswered`, `tool_failed`, `misunderstood`, `other` | 👎 + reason |
| free text | the score's `comment` field | the visitor's words (≤1000 chars) | 👎 + text |

NUMERIC for the thumb because its **average is the satisfaction rate**, straight
out of the metrics API (`scores-numeric` view). A separate CATEGORICAL score for
the reason because the metrics API groups by score name/value — a reason buried
in metadata **cannot be charted**, which would defeat the point. Both are backed
by score **configs** (`scripts/setup-feedback-scores.ts`, run once per project).

Reason labels are the **machine codes**, not the German UI text, so the analytics
taxonomy does not become German-only the day a second locale appears.

## ⚠ Live-instance behaviour that the docs do not state

All measured against this v4 `events_only` instance. Do not "simplify" past them.

1. **Reads only work on `/api/public/v3/scores`.** `/scores` and `/v2/scores`
   both 404 here — the same trap as the v1 traces endpoint.
2. **The read is a PROJECTION.** Without `fields=details`, `comment` and
   `metadata` come back `null` even though they are stored.
3. **Re-POSTing the same `id` UPDATES in place** — that is what makes a 👎→👍
   flip and a retry safe. Ids are deterministic: `fb-{session}-{turn}`.
4. **…but the update is a PARTIAL MERGE.** An omitted field KEEPS its old value.
   Flipping to 👍 while omitting `comment` left the old *negative* comment
   attached to a positive score. `buildScorePayload` therefore **always sends
   every field**; `comment: ""` is what clears it. Never make a field conditional.
5. **A categorical score has no "none" value**, so a flip must `DELETE` the
   reason score (works, 202) rather than blanking it.
6. **Score CONFIG field names differ between the REST API and the MCP tool.**
   REST wants `categories` / `minValue` / `maxValue`; the MCP tool wants
   `categoricalCategories` / `numericMinValue` / `numericMaxValue`. Sending the
   MCP spelling to REST fails with a bare "expected array, received undefined"
   that names no field. Configs also cannot be updated or deleted — only GET
   exists — so a mistake there is permanent.

## How feedback finds the right trace

The browser knows `sessionId` + `message.metadata.turnId`; it never sees a
Langfuse trace id and holds no credential. The server resolves it:

```
widget  ──{sessionId, turnId, thumb, reason?, comment?}──▶  /api/feedback
                                                              │
                            feedbackRefs[(session, turn)] ──▶ traceId ──▶ score
```

`feedbackRefs` is written by the Langfuse hook at turn end (`agent/hooks/langfuse.ts`).

**Production caveat, by design:** that map is process-local (`.data/`), so a
feedback POST landing on a cold serverless instance cannot resolve the trace.
It then degrades to a **session-level** score rather than dropping the vote, and
the turn id is preserved in the score metadata either way. Making it
trace-precise in production means moving this one map to a shared KV; nothing
else changes. The API response reports `precision: "trace" | "session"` so the
downgrade is visible rather than silent.

## Two screens, two projects

The widget's FAQ and Partner screens share one component but trace to two
different Langfuse projects — and service 1 **cannot** resolve a partner trace,
because service 2 created it. So partner votes are forwarded:

```
FAQ screen     → service 1 /api/feedback → Navio — FAQ
Partner screen → service 1 /api/feedback → service 2 /api/feedback → Navio — Partner
```

Service 2's endpoint is internal: it requires `PARTNER_PROXY_SECRET` when one is
set and otherwise accepts loopback only.

## Score-config linkage (added 2026-08-18)

`user-feedback` and `feedback-reason` scores now carry a `configId`, linking
them to their declared Langfuse score configs instead of arriving as loose
values. Controlled by two env vars — unset means the linkage is simply
omitted, feedback still writes exactly as before:

```
LANGFUSE_FEEDBACK_SCORE_CONFIG_ID=
LANGFUSE_REASON_SCORE_CONFIG_ID=
```

`scripts/setup-feedback-scores.ts` prints both after registering (or finding)
the configs — copy them into `.env.local` / the Vercel env.

**The score-config idempotency bug, fixed.** The first version of that script
relied on the create call returning a conflict for "already exists." Langfuse
does not reject a duplicate config name — it silently creates another one. That
produced 3× `user-feedback` and 2× `feedback-reason` duplicate configs in the
FAQ project before this was caught. Score configs have **no update or delete
endpoint** (only GET exists), so those duplicates are permanent, harmless
clutter — the script now lists first and only creates when genuinely absent, so
it cannot make more.

## Annotation Queue — native review workflow (added 2026-08-18)

Every 👎 pushes its trace (or session, if precision degraded) into a Langfuse
**Annotation Queue** named `Negative Feedback Review`, as a `PENDING` item.
Zero new taxonomy — this uses Langfuse's own PENDING/COMPLETED status, nothing
custom.

```
LANGFUSE_FEEDBACK_QUEUE_ID=
```

Unset = feedback still scores normally; nothing gets queued (silent no-op,
same posture as every other unconfigured Langfuse feature here).

**How a team member reviews feedback:**
1. Open the Langfuse UI → **Annotation Queues** → "Negative Feedback Review".
2. Filter `status = PENDING`.
3. Open an item — it links straight to the trace. Read the trace, the
   `user-feedback` score's `comment` (the visitor's own words), and the
   `feedback-reason` value.
4. Optionally click **"+ Add comment"** on the trace (Langfuse's native
   Comments feature — no code involved) to leave a note for the team.
5. Mark the item **COMPLETED**.

**Deduplication.** A retry or double-click of the same vote never creates a
second item — a file-backed marker (`.data/annotation-queue-markers`, mirroring
`feedbackRefs`) remembers which `(objectType, objectId)` pairs are already
queued. **Known accepted limitation:** if precision has degraded to
session-level (the `feedbackRefs` map expired), a second, genuinely different
negative turn in the same session is also suppressed — this matches the
precision Langfuse already accepted for that degraded path, not a new gap.

**A 👎→👍 flip deliberately leaves the queue item alone.** Touching it would
need a persisted `queueItemId` just to find it again, for marginal benefit —
and "flagged, then the visitor reconsidered" is itself useful signal a
reviewer should see, not noise to erase. Do not "fix" this later.

**`scoreConfigIds: []` was rejected when creating the queue** (verified live,
2026-08-18) — the OpenAPI spec's `required` on that field means non-empty, not
just present. The setup script falls back to attaching `feedback-reason`'s
config, so a reviewer sees/can-confirm the visitor's stated reason while
annotating an item, without a new taxonomy being introduced.

## Privacy

Sent: anonymous session id, turn id, thumb, reason code, optional comment.
Not sent: IP, user agent, user id. Comments are volunteered, so they are **not**
gated behind `LANGFUSE_RECORD_IO` (which would lose the signal in production,
where it is off) — disable with `NAVIO_FEEDBACK_ALLOW_TEXT=false`.

## What it answers

Joined against trace metadata already emitted: satisfaction rate over time;
negative rate **by agent / route / model**; `too_slow` complaints vs. actual
`timing.duration_ms`; negative rate where `tools.errors > 0` or
`partner.search_performed = false`; regression by `knowledge.version_digest`.
Natively, on top of that: which negative-feedback traces have not yet been
reviewed (the queue's `status=PENDING` filter), and what a reviewer noted about
them (native Comments on the trace).

## Verifying

```powershell
npx tsx scripts/setup-feedback-scores.ts   # once per Langfuse project — idempotent,
                                            # safe to re-run; prints all 3 env var ids
# then rate an answer at /widget and read it back:
#   GET /api/public/v3/scores?traceId=<id>&fields=details
#   GET /api/public/annotation-queues/<queueId>/items?status=PENDING
```

Verified live end-to-end 2026-08-18, both projects: `configId` present on
written scores, exactly one `PENDING` item created per 👎, a retry of the
identical vote created zero additional items, and a 👎→👍 flip left the
existing item's `updatedAt` byte-for-byte unchanged.
