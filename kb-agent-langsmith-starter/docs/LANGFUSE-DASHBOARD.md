# Navio KB Agent — Langfuse dashboard

**Dashboard:** `Navio KB Agent — Production Monitor`
(`/project/cmsr5mndv00a3qe07s72yugry/dashboards/cmsr9j85z00krqe074bw3ii8f`)
**Project:** `Navio — FAQ` · **Built and verified against live data: 2026-08-13.**

This file records the decisions the dashboard encodes, so nobody has to reverse-engineer a
widget filter, and the instrumentation work the dashboard cannot do without.

---

## 1. The counting rule (the most important thing here)

**One turn = one `answer-delivered` span.** Every request-shaped metric filters on
`name any of ["answer-delivered", "kb-agent-summary"]`.

It would be natural to count the trace root (`visitor-request`) instead. **Do not.**
`humanSpanName()` maps eve's `workflow.route.flow` to `visitor-request`, and that route is
invoked by eve's own machinery on every workflow poll — not once per visitor question.
Measured on 2026-08-13:

| Span | Count | What it really is |
|---|---|---|
| `visitor-request` | 3,584 | every eve workflow HTTP call (~0.07–0.24 s, no input/output, no session id) |
| `answer-delivered` | 10 | actual delivered turns |

Counting the root over-reports traffic by roughly **350×**, and drags every latency average
toward ~0.1 s. `answer-delivered` is emitted for successes *and* failures, carries
`outcome`, tokens, cost and timings, and there is exactly one per trace — verified: 11 summary
spans across 11 distinct trace ids.

Two more counting traps the widgets already avoid:

- **Never count ERROR-level observations as failures.** One real failure marks **7**
  observations ERROR (`failure:agent-{turn,step,session}`, `generate-answer`, `compose-answer`,
  `answer-question`, `apply-knowledge-base`). 3 failures → 21 ERROR rows. The true failure
  count comes from the summary span with `metadata.outcome = failed`.
- **Legacy span names are still in the data.** `kb-agent-request/-turn/-reasoning/
  -model-attempt/-summary` and `answer-from-knowledge-base` (407 observations) predate the
  current naming. Widgets that must span history include both name sets.

## 2. Platform limits worked around

| Limit | Consequence | Workaround used |
|---|---|---|
| `metadata` is **filterable but not groupable** | cannot break down by `outcome`, `error_type`, `knowledge.version_digest` | filter per widget; group by `tags`, which already carry `outcome:*` and `channel:*` |
| Widget filters accept **fewer columns** than the query API — no numeric columns (`totalCost`, `latency`, `inputTokens`) | "generations with zero cost" is not expressible | `Instrumentation · Model resolution` groups by model instead; an empty bucket is the same signal |
| Dashboards have **no period-over-period comparison** | the requested `↓ 0.8%` deltas do not exist in Langfuse | use the date picker; for real deltas ingest scores and read them in the Experiments view |
| Dashboards have **no text/markdown tiles** | no section headings | section is carried in the widget name prefix (`Reliability · …`) and by grid position |
| Widget values are **not click-through to traces** | no drill-down from a bar | widget descriptions name the exact filter to reproduce in the Traces list |

## 3. Instrumentation gaps — what to add, and what each unlocks

Ordered by value. None of these are dashboard bugs; they are missing signals.

1. **Stop naming eve's workflow-route span `visitor-request`.**
   `lib/langfuse.ts` → `humanSpanName()` maps `workflow.route.flow` → `visitor-request`
   unconditionally. Only the invocation that carries a `langfuse.session.id` (and input/output)
   is a real visitor turn; the rest should be dropped by the span filter in
   `agent/instrumentation.ts`. **Unlocks:** an honest request count on the trace root, a
   usable Traces list, and ~99.7 % less ingest volume.
   *Regression check:* `Instrumentation · Root spans` should converge on the `Turns` tile.

2. **Emit Langfuse scores.** There are currently **0 scores and 0 datasets** in the project —
   the eval pipeline still writes to LangSmith. Every widget in the Quality section is
   therefore empty by construction. Emitting scores from `lib/eval/judges.ts` unlocks the whole
   section at once, because the widgets group by score `name`:
   - numeric scores → `Quality · Eval score by dimension` / `· Eval score trend`
     (suggested names: `correctness`, `relevance`, `grounding`, `injection_resistance`,
     `safety`, `language`, `knowledge_retention`)
   - boolean scores → `Quality · Pass rate by check` (its `avg` **is** the pass rate)
   - a boolean `turn_succeeded` score per production turn would also give a true **error-rate
     percentage**, which the observations view cannot express.

3. **Set `completionStartTime` on the generation.** `timeToFirstToken` is **null** on every
   generation, so Langfuse's native TTFT and `streamingLatency` measures are unusable — even
   though the hook already records `timing.first_token_ms` (1693 ms, 2532 ms observed) into
   metadata, where no chart can reach it. **Unlocks:** perceived-latency monitoring, which
   matters more than total duration for a streaming widget.

4. **Put the error classification into trace tags.** `attributes.app.error_type`,
   `.error_cause`, `.user_impact`, `.recommended_action` are all captured, but metadata cannot
   be grouped — so "most common errors" cannot be charted. Adding `error:<type>` to the trace
   tags makes error categories groupable with no other change.

5. **Fix `tokens.cached_input` in the turn summary.** The summary span reports
   `tokens.cached_input: 0` while the generation reports `input_cached_tokens: 17,536` for the
   same turn. The dashboard reads the generation, so its cache chart is right — but anything
   reading the summary metadata is wrong.

6. **Retire the legacy span names**, then delete the legacy entries from the widget filters.

## 4. What this agent structurally cannot report

- **Retrieval metrics.** The KB agent has no retriever: the knowledge base is embedded in the
  system prompt. There are no retrieval spans, no chunks, no empty-retrieval rate — and
  inventing them would be theatre. The Knowledge section measures the honest equivalents:
  prompt size per call (= the KB payload), Azure prompt-cache hit, and model calls per turn.
  Knowledge *provenance* is answered by `knowledge.version_digest` on the trace, not by a chart.
- **Cost or latency per question on the generation.** `traceName` is null on GENERATION
  observations, so "most expensive question" is charted per **session** instead.

## 5. Notes on what the data currently shows

Read at build time (2026-08-13, all `development`, ~1 day of history, 11 turns):

- **94 % of a turn is the Azure call** — `answer-question` P95 4,349 ms vs `generate-answer`
  P95 4,088 ms. There is almost no framework overhead to optimise.
- **Prompt cache is working**: 122,752 cached vs 80,134 fresh input tokens (**60 % hit rate**).
- **Model is `gpt-4o-mini`**, not the `gpt-4.1` documented as the default in
  `agent/agent.ts`. Worth confirming which is intended before reading cost trends.
- All 3 failures are one cause — `permission_denied`, from the deliberately invalid Azure key
  used in the failure-path regression test.

## 6. Exporting the tracing table (the UI button does not work)

**Symptom.** Langfuse → Tracing → Export → *as CSV* queues a job that turns up
**Failed** under Settings → Exports, with no download link. Hovering the badge shows
`An internal error occurred`; the ⓘ shows it ran and finished (the traces job took ~78 s
before failing).

**Diagnosis (2026-09-09).** Not table-specific and not a volume problem: a **scores** CSV
export queued as a control failed the same way within seconds, while the traces job spent
~78 s querying 8 k rows first and then failed at the same step. Both tables share one code
path — write the finished file to blob storage and hand back a signed URL — so the failure
is in that step, on the server.

Self-hosted Langfuse ships **batch export disabled**: it needs, on the Langfuse
**container** (not in this repo),

```
LANGFUSE_S3_BATCH_EXPORT_ENABLED=true
LANGFUSE_S3_BATCH_EXPORT_BUCKET=<bucket>
# plus, unless the pod already has them: _REGION, _ENDPOINT, _ACCESS_KEY_ID,
# _SECRET_ACCESS_KEY, and _FORCE_PATH_STYLE=true for MinIO
```

The bucket that ingestion already uses (`LANGFUSE_S3_EVENT_UPLOAD_*`) can be reused with a
different prefix. The **worker** container's log names the failing step exactly; check it
before changing anything. Note that export completion is announced by email, so SMTP must
also be set for the notification (not for the export itself). Instance version here is
**v4.6.0**, so the old trace-export bug fixed in v3.121.0 is not the cause.

**Meanwhile — export without the UI:**

```bash
npm run export:csv                    # last 30 days → traces-export.csv
npm run export:csv -- out.csv 7       # last 7 days
```

`scripts/export-traces-csv.ts` pages `/api/public/v2/observations` with the project keys
already in `.env.local` and writes a UTF-8-BOM CSV (Excel-safe) with one row per
observation: timing, trace/session ids, level, model, input/output/cached tokens, cost, and
the question/answer. It needs no blob storage. Measured run: 8,468 observations across
8,065 traces, 7.6 MB, $0.151328 total cost for 30 days. The same script is mirrored in the
partner build, where it exports that project instead (the key pair selects the project).
