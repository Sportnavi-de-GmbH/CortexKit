# V3 — Parallel multi-task search

**Date:** 2026-09-14 · **Project:** `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3`
· **Branch:** `v3-partner-retrieval`

## Goal

A single user message may contain several independent search requests
("Tennis in Dortmund, Boxen in München und etwas gegen Rückenschmerzen in München").
V3 should recognise them as separate **tasks**, run up to **3 at a time**, defer the rest to
the next turn, and let a task that needs clarification wait without blocking the others.
Single-task messages must behave exactly as today.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Clarification for one task while others finish | One response containing the finished results and the short question; the pending task is returned in the trace and can be **resumed** on the next request (client holds the state). |
| More than 3 tasks | Only the top 3 run. The rest are **deferred**: named in the answer and returned in the trace for the next turn. Never more than 3 in flight. |
| When to ask | **Missing city only.** Ambiguous activities are searched as-is. |
| Final answer | Per-task stage-6 answers joined by a **deterministic** wrapper. No composing model call. |
| Priority beyond 3 | The decomposer assigns `priority` (complete tasks first, then mention order); code tie-breaks on mention order. |

## Architecture

```
message ─► Stage 0 decompose ─► sort by priority ─► slice(0, maxTasksPerTurn) ─► pool(3)
                                                     └─ rest → deferred
   each task ─► existing stages 1–6 (unchanged) ─► TaskRun
   all TaskRuns ─► compose (pure) ─► answer + pending + deferred
```

### Stage 0 — `workflow/stages/0-decompose.ts`

- New `LlmPort.decompose(query, { pending, signal })` → one `generateObject`, temperature 0.
- Output schema:
  ```ts
  interface Task { id: string; label: string; query: string; cityMention: string | null; priority: number }
  ```
  `id` = `t1..tN` in mention order (fresh ids on every stage-0 call); `label` ≤ 40 chars, used as
  the section heading; `query` is a self-contained sub-query in the user's words; `cityMention`
  verbatim or null; `priority` 1 = first.
- Prompt rules: split only on genuinely independent intents (different activity **or** different
  place); one intent = one task; never invent a city; priority = tasks with both a city and an
  activity first, then mention order; when `pending` tasks are supplied, a reply that answers a
  pending task's question is **merged** into that task (same `id`, updated `query`/`cityMention`)
  instead of becoming a new task.
- Degradation: model failure, empty output, or invalid shape ⇒ exactly one task `{ id: "t1",
  label: <query truncated to 40>, query, cityMention: null, priority: 1 }` plus a warning.
- Code post-processing (not trusted to the model): dedupe identical `query`s, clamp `label`, sort
  by `(priority, mentionIndex)`, hard cap the task list at 10.
- Config: `enableDecomposition` (`V3_ENABLE_DECOMPOSITION`, default `true`) — off ⇒ stage 0 is
  recorded as `skipped` and the whole message is one task; `maxTasksPerTurn`
  (`V3_MAX_TASKS_PER_TURN`, default `3`, validated `1..3`).
- Stage 1 gets an optional `cityMention` hint in its input; when present and non-empty it
  **skips its own detect model call** and uses the hint as the `explicit` candidate. Everything
  else in stage 1 (home/session fallbacks, fuzzy resolve, confidence gate) is unchanged.

### Runner — `workflow/run-workflow.ts`

- Today's stage 1–6 body is extracted verbatim into `runTask(task, input, ctx): Promise<TaskRun>`.
- `runWorkflow` becomes: resolve config/deps → stage 0 → `runnable = tasks.slice(0, maxTasksPerTurn)`,
  `deferred = tasks.slice(maxTasksPerTurn)` → `mapWithConcurrency(runnable, maxTasksPerTurn, runTask)`
  → `compose`.
- `lib/pool.ts` — `mapWithConcurrency<T,R>(items, limit, fn)`: preserves input order, starts the
  next item when one settles, never rejects (fn results are TaskRuns that already carry their own
  status). Tested with an in-flight counter asserting `max ≤ limit`.
- All sub-runs share the run's `AbortSignal` (one `runTimeoutMs` deadline, default unchanged at
  45 s — parallel tasks add no wall time; queued tasks are deferred, not run). Per-stage timeouts
  stay per sub-run.
- Resume: the request may carry `resume: { pending: Task[]; deferred: Task[] }`. Order of the
  next turn's task list = merged/new tasks from stage 0 sorted by priority, **but deferred tasks
  are placed first** (they already waited). The cap and pool apply as usual.

### Trace shape — `workflow/types.ts`

```ts
type WorkflowStatus = "ok" | "needs_clarification" | "partial" | "failed";

interface TaskRun {
  task: Task;
  status: "ok" | "needs_clarification" | "failed";
  totalMs: number;
  stages: StageRecord[];          // stages 1–6 of this task
  answer?: string;
  recommendations?: Recommendation[];
  clarification?: string;
  error?: { message: string };
}

interface WorkflowTrace {
  runId; startedAt; totalMs; input; config;
  status: WorkflowStatus;
  decompose: StageRecord;         // stage 0 (status "skipped" when disabled)
  tasks: TaskRun[];               // executed tasks, in execution-list order
  deferred: Task[];               // not run this turn
  pending: Task[];                // ran, ended in needs_clarification
  stages: StageRecord[];          // = tasks[0].stages when tasks.length === 1, else [] (UI compat)
  answer?: string;                // composed
  clarification?: string;         // composed question text (only when pending.length > 0)
  error?: { message: string };
}
```

Trace status: `ok` — every task ok · `needs_clarification` — ≥1 pending, none failed ·
`partial` — ≥1 failed and ≥1 ok/pending · `failed` — every task failed, or config/deps/stage 0
threw (stage 0 model errors degrade, they do not throw; only a run-abort throws).

`StageId` gains `"decompose"`.

### Compose — `workflow/compose.ts` (pure, tested)

- One task, status `ok` ⇒ `answer` is that task's answer verbatim (no heading, no wrapper).
- Otherwise, sections in execution order, each `**<label>**\n<task answer>`; a failed task
  renders `**<label>**\nBei „<label>" ist gerade etwas schiefgelaufen – versuch es gleich noch
  einmal.`; a pending task renders nothing in the sections.
- Then, if pending: one line `Kurze Frage, bevor ich weitersuche 😄 – für „<label>“: in welcher
  Stadt (oder Umgebung) soll ich schauen?` (multiple pending ⇒ labels joined with „ und “, still
  one question).
- Then, if deferred: `(Notiert für danach: <labels joined by ", "> – sag einfach Bescheid, dann
  suche ich weiter.)`
- Sections joined by a blank line.

### API — `app/api/workflow/route.ts`

Body schema gains `resume: { pending: Task[]; deferred: Task[] }` (optional, each list ≤ 10,
each field length-capped). `GET` unchanged apart from the two new config keys.

### Dev UI

- `QueryForm`: after a run, keeps `pending`/`deferred` from the selected trace and sends them as
  `resume` with the next request; shows a chip “Weiter mit: 1 offen · 2 zurückgestellt” and a
  “×” to clear it. Sending resets the chip from the new trace.
- `page.tsx`: a **task tab strip** above the pipeline strip (label · status · ms); the existing
  pipeline strip and six stage sections render the selected task's `stages`. A new
  **Decompose** section (stage 0) above the task strip shows input, output tasks, priority,
  deferred and warnings. The composed answer and the trace status are shown at the top.
- `EXAMPLE_QUERIES` gets two multi-task examples, one with >3 tasks.

### CLI — `scripts/run.ts`

Prints the composed answer, then one line per task (`label · status · ms`), then pending /
deferred labels. `--json` dumps the full trace as before. No resume flag (UI only).

## Testing

- `stage0-decompose.test.ts` — splits 3; degrades to one task on throw/empty; caps at 10; dedupes;
  sorts by priority then mention; merges a reply into a pending task.
- `pool.test.ts` — order preserved; in-flight never exceeds limit (counter); limit ≥ items.
- `run-workflow.test.ts` (extend) — single task ⇒ trace equal to today's (stages alias, answer
  verbatim, `decompose` recorded); 3 tasks run concurrently (fake backend records overlap);
  5 tasks ⇒ 3 run, 2 deferred, status `ok`, deferred named in answer; 1 clarification + 2 ok ⇒
  `needs_clarification`, 2 sections + question, `pending` has one task; one task failing ⇒
  `partial`; `enableDecomposition:false` ⇒ stage 0 skipped, one task; resume with deferred puts
  them first.
- `stage1-detect-city.test.ts` (extend) — `cityMention` hint skips the model call.
- `compose.test.ts` — every branch above, incl. single-task passthrough.
- `api-route.test.ts` (extend) — `resume` validated.
- `npm run typecheck` and `npm test` green; README updated (pipeline diagram, new dials, trace
  shape, resume contract, cost line: N tasks ⇒ 1 + 3·N chat completions + N embeddings).

## Out of scope

Persisting resume state server-side; wiring into the widget or any live agent; Langfuse;
clarifying ambiguous activities; running deferred tasks in the same request.
