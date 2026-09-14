# V3 Parallel Multi-Task Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one V3 message contain several independent partner searches, run up to 3 of them concurrently through the unchanged stage 1–6 pipeline, defer the rest to the next turn, and let a task that needs a city clarification wait without blocking the others.

**Architecture:** A new stage 0 (`decompose`) splits the message into `Task`s with one `generateObject` call. The existing stage 1–6 body of `runWorkflow` is extracted verbatim into `runTask`, which is run through the already-existing `runWithLimit` semaphore (`lib/reused/limiter.ts`) with `limit = maxTasksPerTurn`. A pure `compose` joins the per-task answers, the clarification question and the "noted for later" line. Resume state (pending + deferred tasks) travels in the request; the lab stays stateless.

**Tech Stack:** TypeScript, Next.js 15 (route + client page), `ai@7` `generateObject`, zod 4, vitest. Project root for every path below: `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/`. Spec: `docs/superpowers/specs/2026-09-14-v3-parallel-search-design.md`.

## Global Constraints

- Never more than **3** tasks in flight: `maxTasksPerTurn` is validated to the integer range `1..3`.
- Clarification is asked for a **missing city only** (unchanged stage-1 rule).
- Single-task runs must produce the same `stages`, `answer`, `clarification` and `error` as today.
- No composing model call: the final answer is assembled by pure code.
- `lib/reused/*` files are copies — do not edit them. Reuse `runWithLimit` instead of adding a pool.
- V3 never imports across folder boundaries (no imports from `../partner-recommendation-agent-*`).
- Commit messages: prefix `v3:`; **no** `Co-Authored-By` / Claude trailers (CLAUDE.md §13 overrides the harness default).
- `npm run typecheck` and `npm test` must be green at the end of every task.
- Copy in the user-facing answer is German, per Du; the clarification line is exactly
  `Kurze Frage, bevor ich weitersuche 😄 – für „<label>“: in welcher Stadt (oder Umgebung) soll ich schauen?`

## File map

| File | Responsibility |
|---|---|
| `config/workflow.config.ts` (modify) | two new dials + validation |
| `workflow/types.ts` (modify) | `Task`, `RawTask` re-export, `DecomposeOutput`, `TaskRun`, `ResumeState`, new `WorkflowTrace` shape |
| `lib/llm-port.ts` (modify) | `decompose()` on the port + Azure implementation |
| `workflow/stages/0-decompose.ts` (create) | stage 0: model call, normalisation, carry deferred, split runnable/deferred |
| `workflow/stages/1-detect-city.ts` (modify) | optional `cityMention` hint skips the detect call |
| `workflow/compose.ts` (create) | pure answer/clarification composition |
| `workflow/run-workflow.ts` (modify) | `runTask` extraction, stage 0, pool, status, compose |
| `app/api/workflow/route.ts` (modify) | `resume` in the body schema |
| `scripts/run.ts` (modify) | multi-task CLI output |
| `components/TaskStrip.tsx`, `components/stages/DecomposeView.tsx` (create), `components/QueryForm.tsx`, `app/page.tsx`, `lib/ui/format.ts`, `lib/ui/examples.ts` (modify) | dev UI |
| `tests/_fakes.ts` (modify), `tests/stage0-decompose.test.ts`, `tests/compose.test.ts` (create), `tests/config.test.ts`, `tests/stage1-detect-city.test.ts`, `tests/run-workflow.test.ts`, `tests/api-route.test.ts` (modify) | tests |
| `README.md` (modify) | docs |

---

### Task 1: Config dials `enableDecomposition` and `maxTasksPerTurn`

**Files:**
- Modify: `config/workflow.config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `WorkflowConfig.enableDecomposition: boolean` (default `true`, env `V3_ENABLE_DECOMPOSITION`) and `WorkflowConfig.maxTasksPerTurn: number` (default `3`, env `V3_MAX_TASKS_PER_TURN`, validated integer in `[1,3]`).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("workflow config")` block of `tests/config.test.ts`:

```ts
  it("has the stage-0 defaults and reads their env vars", () => {
    expect(DEFAULT_CONFIG.enableDecomposition).toBe(true);
    expect(DEFAULT_CONFIG.maxTasksPerTurn).toBe(3);
    const { config, envSet } = loadConfigFromEnv({ V3_ENABLE_DECOMPOSITION: "false", V3_MAX_TASKS_PER_TURN: "2" } as unknown as NodeJS.ProcessEnv);
    expect(config.enableDecomposition).toBe(false);
    expect(config.maxTasksPerTurn).toBe(2);
    expect(envSet.sort()).toEqual(["enableDecomposition", "maxTasksPerTurn"]);
  });

  it("never allows more than 3 tasks per turn", () => {
    expect(() => resolveConfig({ maxTasksPerTurn: 4 }, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ maxTasksPerTurn: 0 }, {} as NodeJS.ProcessEnv)).toThrow(/maxTasksPerTurn/);
    expect(() => resolveConfig({ maxTasksPerTurn: 2.5 }, {} as NodeJS.ProcessEnv)).toThrow(/maxTasksPerTurn/);
    expect(resolveConfig({ maxTasksPerTurn: 1 }, {} as NodeJS.ProcessEnv).maxTasksPerTurn).toBe(1);
  });
```

Also update the existing `"has the spec defaults"` expectation object: add `enableDecomposition: true, maxTasksPerTurn: 3,` after `modelTimeoutMs: 20_000,`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `enableDecomposition` undefined / `maxTasksPerTurn` undefined.

- [ ] **Step 3: Implement**

In `config/workflow.config.ts`:

Add to the `WorkflowConfig` interface, after `modelTimeoutMs: number;`:
```ts
  /** Stage 0: split the message into independent search tasks (off ⇒ the whole message is one task). */
  enableDecomposition: boolean;
  /** Stage 0: tasks run per turn, and the concurrency of the task pool. Hard-capped at 3 by validation. */
  maxTasksPerTurn: number;
```
Add to `DEFAULT_CONFIG` after `modelTimeoutMs: 20_000,`:
```ts
  enableDecomposition: true,
  maxTasksPerTurn: 3,
```
Add to `V3_ENV` after `modelTimeoutMs: "V3_MODEL_TIMEOUT_MS",`:
```ts
  enableDecomposition: "V3_ENABLE_DECOMPOSITION",
  maxTasksPerTurn: "V3_MAX_TASKS_PER_TURN",
```
Add to `validateConfig` before `return c;`:
```ts
  assert(int(c.maxTasksPerTurn) && c.maxTasksPerTurn >= 1 && c.maxTasksPerTurn <= 3, "maxTasksPerTurn must be an integer in [1,3] (never more than 3 searches in parallel)");
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/config.test.ts` → PASS. Run `npm run typecheck` → clean (the `ConfigPanel` derives its rows from `Object.keys(defaults)`, so both dials appear automatically).

- [ ] **Step 5: Commit**

```bash
git add config/workflow.config.ts tests/config.test.ts
git commit -m "v3: config dials enableDecomposition and maxTasksPerTurn (capped at 3)"
```

---

### Task 2: Types, `LlmPort.decompose`, and the fake

**Files:**
- Modify: `workflow/types.ts`, `lib/llm-port.ts`, `tests/_fakes.ts`

**Interfaces:**
- Produces (types):
  ```ts
  interface RawTask { label: string; query: string; cityMention: string | null; priority: number; resolvesPending: string | null }  // lib/llm-port.ts
  interface Task { id: string; label: string; query: string; cityMention: string | null; priority: number }
  interface ResumeState { pending: Task[]; deferred: Task[] }
  interface DecomposeOutput { tasks: Task[]; runnable: Task[]; deferred: Task[]; fresh: string[]; degraded: boolean; model?: string }
  type TaskStatus = "ok" | "needs_clarification" | "failed"
  interface TaskRun { task: Task; status: TaskStatus; totalMs: number; stages: StageRecord[]; answer?: string; recommendations?: Recommendation[]; clarification?: string; error?: { message: string } }
  type WorkflowStatus = "ok" | "needs_clarification" | "partial" | "failed"
  WorkflowInput.resume?: ResumeState
  WorkflowTrace: + decompose: StageRecord; tasks: TaskRun[]; deferred: Task[]; pending: Task[]   (stages, answer, clarification, error kept)
  StageId: + "decompose"
  ```
- Produces (port): `LlmPort.decompose(query: string, opts: { pending: Task[]; signal: AbortSignal }): Promise<{ tasks: RawTask[] }>`
- Produces (fake): `fakeLlm({ decompose?: RawTask[] | ((query: string, pending: Task[]) => RawTask[]); failDecompose?: Error })`; default = one task for the whole query whose `cityMention` follows the fake's `cityMention` option; `calls` records `{ fn: "decompose", arg: query }`.

- [ ] **Step 1: Edit `workflow/types.ts`**

Replace `export type StageId = ...` with:
```ts
export type StageId = "decompose" | "detect-city" | "reformulate" | "nearby-cities" | "search" | "rerank" | "respond";
```
Replace the `WorkflowInput` interface with:
```ts
export interface WorkflowInput {
  query: string;
  homeCity?: string;
  sessionCities?: string[];
  /** Tasks carried over from the previous turn (client-held). */
  resume?: ResumeState;
}

/** One independent search request extracted from the message. */
export interface Task {
  id: string;
  /** ≤ 40 chars, used as the answer section heading. */
  label: string;
  /** Self-contained sub-query in the user's words. */
  query: string;
  cityMention: string | null;
  /** 1 = run first. */
  priority: number;
}

export interface ResumeState {
  /** Ran last turn, ended in needs_clarification. */
  pending: Task[];
  /** Not run last turn (beyond maxTasksPerTurn). */
  deferred: Task[];
}

export interface DecomposeOutput {
  /** Every task of this turn in execution order (carried deferred first). */
  tasks: Task[];
  runnable: Task[];
  deferred: Task[];
  /** ids of the tasks produced by THIS turn's model call (carried deferred tasks are not fresh). */
  fresh: string[];
  /** true when the model call failed/returned nothing and the whole message became one task. */
  degraded: boolean;
  model?: string;
}
```
Replace `export type WorkflowStatus = ...` and the `WorkflowTrace` interface with:
```ts
export type TaskStatus = "ok" | "needs_clarification" | "failed";

/** Stages 1–6 for one task. */
export interface TaskRun {
  task: Task;
  status: TaskStatus;
  totalMs: number;
  stages: StageRecord[];
  answer?: string;
  recommendations?: Recommendation[];
  clarification?: string;
  error?: { message: string };
}

export type WorkflowStatus = "ok" | "needs_clarification" | "partial" | "failed";

export interface WorkflowTrace {
  runId: string;
  startedAt: string;
  totalMs: number;
  status: WorkflowStatus;
  input: WorkflowInput;
  config: WorkflowConfig;
  /** Stage 0. `skipped` when decomposition is disabled or config/deps failed. */
  decompose: StageRecord;
  tasks: TaskRun[];
  deferred: Task[];
  pending: Task[];
  /** = tasks[0].stages when exactly one task ran, else []. Kept so single-task traces read as before. */
  stages: StageRecord[];
  /** Composed answer (verbatim task answer for a single task). */
  answer?: string;
  recommendations?: Recommendation[];
  clarification?: string;
  error?: { message: string };
}
```
Add at the end of the file:
```ts
export type { RawTask } from "../lib/llm-port";
```

- [ ] **Step 2: Edit `lib/llm-port.ts`**

Add before the `LlmPort` interface:
```ts
import type { Task } from "../workflow/types";

/** What the decomposition model returns per task; ids are assigned by stage 0, not the model. */
export interface RawTask {
  label: string;
  query: string;
  cityMention: string | null;
  priority: number;
  /** id of a pending task this message answers (merge into it), else null. */
  resolvesPending: string | null;
}
```
Add to the `LlmPort` interface, before `detectCity`:
```ts
  /** Stage 0: independent search tasks in the message; may merge a pending task. */
  decompose(query: string, opts: { pending: Task[]; signal: AbortSignal }): Promise<{ tasks: RawTask[] }>;
```
Add after `citySchema`:
```ts
const rawTaskSchema = z.object({
  label: z.string().describe("Short heading for this search, at most 40 characters, e.g. 'Tennis in Dortmund'."),
  query: z.string().describe("Self-contained German sub-query in the user's own words, including the place if the user named one for it."),
  cityMention: z.string().nullable().describe("The place VERBATIM as written for this task (may be misspelled), or null. Never guess. 'in meiner Nähe' / 'hier' are NOT a city."),
  priority: z.number().int().describe("1 = run first. Tasks with both a place and an activity before tasks missing one; otherwise order of mention."),
  resolvesPending: z.string().nullable().describe("id of the pending task this message answers (usually by naming its city), else null."),
});
const decomposeSchema = z.object({ tasks: z.array(rawTaskSchema) });

const DECOMPOSE_SYSTEM = [
  "You split one user message into independent partner-search tasks for a German sports, health and therapy directory.",
  "Rules:",
  "- One task per genuinely independent search intent. Two intents are independent when they differ in the activity/health need OR in the place. Closely related activities the user wants in one list (e.g. 'Yoga oder Pilates in Bochum') stay ONE task.",
  "- query: a self-contained German sub-query in the user's own words; include the place if the user named one for that intent.",
  "- label: at most 40 characters.",
  "- cityMention: the place VERBATIM as written, or null. Never invent or guess a city.",
  "- priority: 1 = run first. Tasks that have both a place and an activity come before tasks missing one; otherwise keep the order of mention.",
  "- If pending tasks are given and the message answers one of their open questions (usually by naming a city), set resolvesPending to that task's id and put the completed request into query/cityMention. Otherwise resolvesPending is null.",
  "- A message that is not a search still yields exactly one task with the whole message as query.",
  "- Never return zero tasks.",
].join("\n");
```
Add to the returned object in `createAzureLlmPort`, before `async detectCity`:
```ts
    async decompose(query, { pending, signal }) {
      const pendingText = pending.length
        ? `\n\nPending tasks from the previous turn (id · label · query):\n${pending.map((p) => `- ${p.id} · ${p.label} · ${p.query}`).join("\n")}`
        : "";
      const { object } = await generateObject({
        model, schema: decomposeSchema, abortSignal: signal, temperature: 0,
        system: DECOMPOSE_SYSTEM,
        prompt: `User message:\n${query}${pendingText}`,
      });
      return { tasks: object.tasks };
    },
```

- [ ] **Step 3: Edit `tests/_fakes.ts`**

Change the `LlmPort` import line to:
```ts
import type { LlmPort, RawTask } from "../lib/llm-port";
import type { StageContext, Task, WorkflowDeps } from "../workflow/types";
```
(remove the old `StageContext, WorkflowDeps` import line). Replace `FakeLlmOptions`, `FakeLlm` and `fakeLlm` with:
```ts
export interface FakeLlmOptions {
  cityMention?: string | null | ((query: string) => string | null);
  reformulated?: string | ((query: string) => string);
  answer?: string | ((prompt: string) => string);
  /** Stage 0 result. Default: one task = the whole query, cityMention per `cityMention`. */
  decompose?: RawTask[] | ((query: string, pending: Task[]) => RawTask[]);
  failDetect?: Error;
  failReformulate?: Error;
  failAnswer?: Error;
  failDecompose?: Error;
}
export interface FakeLlm extends LlmPort {
  calls: Array<{ fn: "decompose" | "detectCity" | "reformulate" | "answer"; arg: string }>;
}
export function fakeLlm(o: FakeLlmOptions = {}): FakeLlm {
  const calls: FakeLlm["calls"] = [];
  const mention = (query: string): string | null => {
    const m = typeof o.cityMention === "function" ? o.cityMention(query) : o.cityMention;
    return m === undefined ? null : m;
  };
  return {
    modelName: "fake-model",
    calls,
    async decompose(query, { pending }) {
      calls.push({ fn: "decompose", arg: query });
      if (o.failDecompose) throw o.failDecompose;
      if (o.decompose === undefined) return { tasks: [{ label: query.slice(0, 40), query, cityMention: mention(query), priority: 1, resolvesPending: null }] };
      return { tasks: typeof o.decompose === "function" ? o.decompose(query, pending) : o.decompose };
    },
    async detectCity(query) {
      calls.push({ fn: "detectCity", arg: query });
      if (o.failDetect) throw o.failDetect;
      return { cityMention: mention(query) };
    },
    async reformulate(query) {
      calls.push({ fn: "reformulate", arg: query });
      if (o.failReformulate) throw o.failReformulate;
      if (o.reformulated === undefined) return `REFORMULATED: ${query}`;
      return typeof o.reformulated === "function" ? o.reformulated(query) : o.reformulated;
    },
    async answer(prompt) {
      calls.push({ fn: "answer", arg: prompt });
      if (o.failAnswer) throw o.failAnswer;
      if (o.answer === undefined) return "ANSWER";
      return typeof o.answer === "function" ? o.answer(prompt) : o.answer;
    },
  };
}
```
Add a builder at the end of the file:
```ts
/** A RawTask with sensible defaults for stage-0 tests. */
export function rawTask(p: Pick<RawTask, "query"> & Partial<RawTask>): RawTask {
  return { label: p.query.slice(0, 40), cityMention: null, priority: 1, resolvesPending: null, ...p };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: errors ONLY in `workflow/run-workflow.ts` (the trace it builds lacks `decompose/tasks/deferred/pending`) and possibly `app/page.tsx`/`scripts/run.ts` (none expected — they read only kept fields). Tests still run: `npm test` → all existing tests PASS (the fake's default decompose is never called yet). If anything else errors, fix it before committing.

Interim fix so the build is green at commit time — in `workflow/run-workflow.ts`, change the `done` helper's parameter type and body to:
```ts
  const done = (partial: Partial<WorkflowTrace> & { status: WorkflowTrace["status"]; config: WorkflowConfig; stages: StageRecord[] }): WorkflowTrace =>
    ({ runId, startedAt, totalMs: Math.round(performance.now() - t0), input, decompose: skipped("decompose"), tasks: [], deferred: [], pending: [], ...partial });
```
and add `decompose: "Decompose message",` as the first entry of `TITLES`. Run `npm run typecheck` → clean; `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add workflow/types.ts lib/llm-port.ts tests/_fakes.ts workflow/run-workflow.ts
git commit -m "v3: task/trace types, LlmPort.decompose with Azure prompt, fake decompose"
```

---

### Task 3: Stage 0 — decompose

**Files:**
- Create: `workflow/stages/0-decompose.ts`
- Test: `tests/stage0-decompose.test.ts`

**Interfaces:**
- Consumes: `LlmPort.decompose`, `raceAbort` (`lib/abortable.ts`), `timeoutSignal` (`lib/reused/timeout.ts`), config dials from Task 1.
- Produces: `decompose(input: { query: string; resume?: ResumeState }, ctx: StageContext): Promise<StageResult<DecomposeOutput>>` and `newTaskId(): string`.

Behaviour: disabled ⇒ single task, no model call. Model throws / returns no usable task ⇒ single task, `degraded: true`, warning. Normalisation: trim, drop empty queries, clamp label to 40 chars (fallback: query clamped), `priority` non-finite ⇒ mention index + 1, `resolvesPending` matching a pending id ⇒ reuse that id else fresh id, dedupe on lower-cased query (first wins), sort by `(priority, mentionIndex)`, cap 10. Carried deferred tasks (whose id no fresh task reuses) go FIRST. `runnable = all.slice(0, maxTasksPerTurn)`, `deferred = all.slice(maxTasksPerTurn)`. Unmerged pending tasks are dropped (the question was asked once).

- [ ] **Step 1: Write the failing tests**

Create `tests/stage0-decompose.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decompose } from "../workflow/stages/0-decompose";
import { ctx, fakeLlm, rawTask } from "./_fakes";
import type { Task } from "../workflow/types";

const Q = "Tennis in Dortmund, Boxen in München und etwas gegen Rückenschmerzen in München";
const THREE = [
  rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund" }),
  rawTask({ label: "Boxen in München", query: "Boxen in München", cityMention: "München", priority: 2 }),
  rawTask({ label: "Rückenschmerzen in München", query: "etwas gegen Rückenschmerzen in München", cityMention: "München", priority: 3 }),
];
const task = (id: string, query: string, priority = 1): Task => ({ id, label: query, query, cityMention: null, priority });

describe("stage 0 — decompose", () => {
  it("splits the message into tasks with fresh ids and puts them all in runnable when ≤ max", async () => {
    const r = await decompose({ query: Q }, ctx({}, { llm: fakeLlm({ decompose: THREE }) }));
    expect(r.output.tasks.map((t) => t.label)).toEqual(["Tennis in Dortmund", "Boxen in München", "Rückenschmerzen in München"]);
    expect(new Set(r.output.tasks.map((t) => t.id)).size).toBe(3);
    expect(r.output.runnable).toHaveLength(3);
    expect(r.output.deferred).toEqual([]);
    expect(r.output.degraded).toBe(false);
    expect(r.output.fresh).toEqual(r.output.tasks.map((t) => t.id));
    expect(r.output.model).toBe("fake-model");
    expect(r.counts).toMatchObject({ fresh: 3, carried: 0, runnable: 3, deferred: 0 });
  });

  it("defers everything beyond maxTasksPerTurn", async () => {
    const five = [...THREE, rawTask({ query: "Klettern in Köln", cityMention: "Köln", priority: 4 }), rawTask({ query: "Schwimmen in Essen", cityMention: "Essen", priority: 5 })];
    const r = await decompose({ query: Q }, ctx({ maxTasksPerTurn: 3 }, { llm: fakeLlm({ decompose: five }) }));
    expect(r.output.runnable.map((t) => t.query)).toEqual(["Tennis in Dortmund", "Boxen in München", "etwas gegen Rückenschmerzen in München"]);
    expect(r.output.deferred.map((t) => t.query)).toEqual(["Klettern in Köln", "Schwimmen in Essen"]);
  });

  it("sorts by priority, then mention order", async () => {
    const raw = [rawTask({ query: "Yoga", priority: 2 }), rawTask({ query: "Boxen in Essen", cityMention: "Essen", priority: 1 }), rawTask({ query: "Tennis in Bochum", cityMention: "Bochum", priority: 1 })];
    const r = await decompose({ query: "x" }, ctx({}, { llm: fakeLlm({ decompose: raw }) }));
    expect(r.output.tasks.map((t) => t.query)).toEqual(["Boxen in Essen", "Tennis in Bochum", "Yoga"]);
  });

  it("dedupes identical queries, clamps labels, defaults a bad priority, caps at 10", async () => {
    const raw = [
      rawTask({ label: "x".repeat(80), query: "Yoga in Bochum", priority: Number.NaN }),
      rawTask({ query: "yoga in bochum " }),
      ...Array.from({ length: 12 }, (_, i) => rawTask({ query: `Sport ${i} in Essen`, priority: 5 })),
    ];
    const r = await decompose({ query: "x" }, ctx({}, { llm: fakeLlm({ decompose: raw }) }));
    expect(r.output.tasks).toHaveLength(10);
    expect(r.output.tasks[0]!.label).toHaveLength(40);
    expect(r.output.tasks[0]!.priority).toBe(1);
    expect(r.output.tasks.filter((t) => t.query.toLowerCase().trim() === "yoga in bochum")).toHaveLength(1);
  });

  it("degrades to one task when the model fails", async () => {
    const r = await decompose({ query: Q }, ctx({}, { llm: fakeLlm({ failDecompose: new Error("model down") }) }));
    expect(r.output.degraded).toBe(true);
    expect(r.output.tasks).toEqual([expect.objectContaining({ query: Q, cityMention: null, priority: 1 })]);
    expect(r.output.tasks[0]!.label).toBe(Q.slice(0, 40));
    expect(r.warnings[0]).toMatch(/model down/);
  });

  it("degrades to one task when the model returns nothing usable", async () => {
    const r = await decompose({ query: Q }, ctx({}, { llm: fakeLlm({ decompose: [rawTask({ query: "   " })] }) }));
    expect(r.output.degraded).toBe(true);
    expect(r.output.tasks).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/no tasks/i);
  });

  it("skips the model when decomposition is disabled", async () => {
    const llm = fakeLlm({ decompose: THREE });
    const r = await decompose({ query: Q }, ctx({ enableDecomposition: false }, { llm }));
    expect(llm.calls).toEqual([]);
    expect(r.output.tasks).toHaveLength(1);
    expect(r.output.degraded).toBe(false);
    expect(r.config).toEqual({ enableDecomposition: false, maxTasksPerTurn: 3 });
  });

  it("merges a reply into the pending task it resolves, keeping that task's id", async () => {
    const pending = [task("p1", "Tennis")];
    const llm = fakeLlm({ decompose: (_q, p) => [rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", resolvesPending: p[0]!.id })] });
    const r = await decompose({ query: "Dortmund", resume: { pending, deferred: [] } }, ctx({}, { llm }));
    expect(r.output.tasks).toEqual([{ id: "p1", label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", priority: 1 }]);
  });

  it("carries deferred tasks first, ahead of new ones, and drops unmerged pending tasks", async () => {
    const deferred = [task("d1", "Klettern in Köln"), task("d2", "Schwimmen in Essen")];
    const pending = [task("p1", "Tennis")];
    const r = await decompose(
      { query: "Und Yoga in Bochum bitte", resume: { pending, deferred } },
      ctx({ maxTasksPerTurn: 2 }, { llm: fakeLlm({ decompose: [rawTask({ query: "Yoga in Bochum", cityMention: "Bochum" })] }) }),
    );
    expect(r.output.tasks.map((t) => t.id)).toEqual(["d1", "d2", expect.any(String)]);
    expect(r.output.runnable.map((t) => t.id)).toEqual(["d1", "d2"]);
    expect(r.output.deferred.map((t) => t.query)).toEqual(["Yoga in Bochum"]);
    expect(r.output.tasks.some((t) => t.id === "p1")).toBe(false);
    expect(r.output.fresh).toHaveLength(1);
    expect(r.counts).toMatchObject({ fresh: 1, carried: 2, runnable: 2, deferred: 1 });
  });
});
```
- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/stage0-decompose.test.ts`
Expected: FAIL — cannot resolve `../workflow/stages/0-decompose`.

- [ ] **Step 3: Implement `workflow/stages/0-decompose.ts`**

```ts
/**
 * Stage 0 — Split the message into independent search tasks.
 * One model call; ids are assigned HERE (never by the model). Deferred tasks
 * from the previous turn go first (they already waited); a pending task is
 * kept only when the model says this message resolves it. The model failing
 * or returning nothing usable degrades to "the whole message is one task".
 */
import { randomUUID } from "node:crypto";
import { raceAbort } from "../../lib/abortable";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { RawTask } from "../../lib/llm-port";
import type { DecomposeOutput, ResumeState, StageContext, StageResult, Task } from "../types";

export const MAX_LABEL_CHARS = 40;
export const MAX_TASKS = 10;

export function newTaskId(): string {
  return randomUUID().slice(0, 8);
}

function singleTask(query: string): Task {
  return { id: newTaskId(), label: query.slice(0, MAX_LABEL_CHARS), query, cityMention: null, priority: 1 };
}

/** Trim, drop empties, clamp, assign ids, dedupe, sort by (priority, mention order), cap. */
export function normalizeTasks(raw: RawTask[], pending: Task[]): Task[] {
  const pendingIds = new Set(pending.map((p) => p.id));
  const seen = new Set<string>();
  const tasks: Array<Task & { mentionIndex: number }> = [];
  raw.forEach((r, mentionIndex) => {
    const query = (r.query ?? "").trim();
    if (!query) return;
    const key = query.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const label = ((r.label ?? "").trim() || query).slice(0, MAX_LABEL_CHARS);
    const cityMention = (r.cityMention ?? "").trim() || null;
    const priority = Number.isFinite(r.priority) ? r.priority : mentionIndex + 1;
    const id = r.resolvesPending && pendingIds.has(r.resolvesPending) ? r.resolvesPending : newTaskId();
    tasks.push({ id, label, query, cityMention, priority, mentionIndex });
  });
  tasks.sort((a, b) => a.priority - b.priority || a.mentionIndex - b.mentionIndex);
  return tasks.slice(0, MAX_TASKS).map(({ mentionIndex: _m, ...t }) => t);
}

export async function decompose(input: { query: string; resume?: ResumeState }, ctx: StageContext): Promise<StageResult<DecomposeOutput>> {
  const config = { enableDecomposition: ctx.config.enableDecomposition, maxTasksPerTurn: ctx.config.maxTasksPerTurn };
  const pending = input.resume?.pending ?? [];
  const deferredIn = input.resume?.deferred ?? [];
  const warnings: string[] = [];
  let fresh: Task[] = [];
  let degraded = false;
  let model: string | undefined;

  if (!ctx.config.enableDecomposition) {
    fresh = [singleTask(input.query)];
  } else {
    try {
      const signal = AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.modelTimeoutMs)]);
      const raw = await raceAbort(ctx.deps.llm.decompose(input.query, { pending, signal }), signal, "decompose");
      fresh = normalizeTasks(raw.tasks ?? [], pending);
      model = ctx.deps.llm.modelName;
      if (fresh.length === 0) {
        warnings.push("Decomposition returned no tasks; treating the message as one task.");
        fresh = [singleTask(input.query)];
        degraded = true;
      }
    } catch (e) {
      warnings.push(`Decomposition failed (${(e as Error).message}); treating the message as one task.`);
      fresh = [singleTask(input.query)];
      degraded = true;
    }
  }

  const freshIds = new Set(fresh.map((t) => t.id));
  const carried = deferredIn.filter((t) => !freshIds.has(t.id));
  const tasks = [...carried, ...fresh];
  const runnable = tasks.slice(0, ctx.config.maxTasksPerTurn);
  const deferred = tasks.slice(ctx.config.maxTasksPerTurn);
  const dropped = pending.filter((p) => !freshIds.has(p.id));
  if (dropped.length) warnings.push(`Pending task(s) not answered by this message were dropped: ${dropped.map((p) => p.label).join(", ")}.`);

  return {
    output: { tasks, runnable, deferred, fresh: fresh.map((t) => t.id), degraded, ...(model ? { model } : {}) },
    config,
    counts: { fresh: fresh.length, carried: carried.length, runnable: runnable.length, deferred: deferred.length, pendingIn: pending.length },
    warnings,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/stage0-decompose.test.ts` → PASS (9 tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add workflow/stages/0-decompose.ts tests/stage0-decompose.test.ts
git commit -m "v3: stage 0 decompose — split message into tasks, carry deferred, split runnable/deferred"
```

---

### Task 4: Stage 1 accepts a `cityMention` hint

**Files:**
- Modify: `workflow/stages/1-detect-city.ts`
- Test: `tests/stage1-detect-city.test.ts`

**Interfaces:**
- Produces: `detectCity(input: WorkflowInput & { cityMention?: string | null }, ctx)`. `cityMention !== undefined` ⇒ no model call; the hint (trimmed, `""` ⇒ null) is the `explicit` candidate. Stage config gains `cityMentionSource: "override" | "hint" | "model"`.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe` of `tests/stage1-detect-city.test.ts`:
```ts
  it("a cityMention hint from stage 0 skips the detect model call", async () => {
    const llm = fakeLlm({ cityMention: "Bochum" });
    const r = await detectCity({ query: Q, cityMention: "Dortmund" }, ctx({}, { llm }));
    expect(llm.calls).toEqual([]);
    expect(r.output.cityMention).toBe("Dortmund");
    expect(r.output.target).toMatchObject({ canonical: "Dortmund", source: "explicit" });
    expect(r.config.cityMentionSource).toBe("hint");
  });

  it("a null hint means 'no city in the text' and still falls back to the home city without a model call", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund" });
    const r = await detectCity({ query: "Ich suche Yoga", cityMention: null, homeCity: "Bochum" }, ctx({}, { llm }));
    expect(llm.calls).toEqual([]);
    expect(r.output.target).toMatchObject({ canonical: "Bochum", source: "home" });
  });

  it("without a hint the model is still asked", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund" });
    const r = await detectCity({ query: Q }, ctx({}, { llm }));
    expect(llm.calls.map((c) => c.fn)).toEqual(["detectCity"]);
    expect(r.config.cityMentionSource).toBe("model");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/stage1-detect-city.test.ts` → FAIL (model called; `cityMentionSource` undefined).

- [ ] **Step 3: Implement**

In `workflow/stages/1-detect-city.ts`, change the signature and the override/model block:
```ts
export async function detectCity(input: WorkflowInput & { cityMention?: string | null }, ctx: StageContext): Promise<StageResult<DetectCityOutput>> {
  const warnings: string[] = [];
  const candidates: Array<{ source: CitySource; mention: string }> = [];
  let cityMention: string | null = null;
  let cityMentionSource: "override" | "hint" | "model" = "model";

  if (ctx.config.targetCity) {
    cityMentionSource = "override";
    candidates.push({ source: "override", mention: ctx.config.targetCity });
  } else {
    if (input.cityMention !== undefined) {
      // Stage 0 already extracted the place for this task — no second model call.
      cityMentionSource = "hint";
      cityMention = input.cityMention?.trim() || null;
    } else {
      try {
        const signal = anySignal(ctx, ctx.config.modelTimeoutMs);
        cityMention = (await raceAbort(ctx.deps.llm.detectCity(input.query, { signal }), signal, "detectCity")).cityMention;
      } catch (e) {
        warnings.push(`City detection model call failed (${(e as Error).message}); treating the question as having no city mention.`);
      }
    }
    if (cityMention && cityMention.trim()) candidates.push({ source: "explicit", mention: cityMention.trim() });
    if (input.homeCity?.trim()) candidates.push({ source: "home", mention: input.homeCity.trim() });
    for (const c of input.sessionCities ?? []) if (c.trim()) candidates.push({ source: "session", mention: c.trim() });
  }
```
and the returned `config` becomes:
```ts
    config: { cityConfidenceMin: ctx.config.cityConfidenceMin, targetCity: ctx.config.targetCity, cityMentionSource },
```
Update the header comment's first lines to: `Order: config.targetCity (override) → stage 0's cityMention hint, or the city mentioned in the question (model) → input.homeCity → input.sessionCities (most recent first).`

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/stage1-detect-city.test.ts` → PASS. `npm test` → PASS (the runner does not pass a hint yet).

- [ ] **Step 5: Commit**

```bash
git add workflow/stages/1-detect-city.ts tests/stage1-detect-city.test.ts
git commit -m "v3: stage 1 takes stage 0's cityMention hint and skips its own detect call"
```

---

### Task 5: `compose` — pure answer assembly

**Files:**
- Create: `workflow/compose.ts`
- Test: `tests/compose.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CLARIFICATION: string   // moved here from run-workflow.ts (same text)
  export function clarificationFor(labels: string[]): string
  export function deferredNote(labels: string[]): string
  export function failedSection(label: string): string
  export function compose(args: { tasks: TaskRun[]; deferred: Task[] }): { answer?: string; clarification?: string; pending: Task[] }
  ```
  Single task with no deferred ⇒ passthrough (`ok` → its answer; `needs_clarification` → `clarification: CLARIFICATION`, no answer; `failed` → neither). Otherwise sections `**label**\n<answer>` in task order, failed tasks get `failedSection`, pending tasks no section; then the question; then the deferred note; joined by blank lines.

- [ ] **Step 1: Write the failing tests**

Create `tests/compose.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CLARIFICATION, clarificationFor, compose, deferredNote, failedSection } from "../workflow/compose";
import type { Task, TaskRun } from "../workflow/types";

const task = (id: string, label: string): Task => ({ id, label, query: label, cityMention: null, priority: 1 });
const ok = (id: string, label: string, answer: string): TaskRun => ({ task: task(id, label), status: "ok", totalMs: 1, stages: [], answer, recommendations: [] });
const pending = (id: string, label: string): TaskRun => ({ task: task(id, label), status: "needs_clarification", totalMs: 1, stages: [], clarification: CLARIFICATION });
const failed = (id: string, label: string): TaskRun => ({ task: task(id, label), status: "failed", totalMs: 1, stages: [], error: { message: "boom" } });

describe("compose", () => {
  it("single ok task ⇒ the task answer verbatim, nothing else", () => {
    expect(compose({ tasks: [ok("a", "Yoga in Bochum", "**Gefunden.**")], deferred: [] })).toEqual({ answer: "**Gefunden.**", pending: [] });
  });

  it("single pending task ⇒ the classic clarification, no answer", () => {
    const r = compose({ tasks: [pending("a", "Yoga")], deferred: [] });
    expect(r).toEqual({ clarification: CLARIFICATION, pending: [task("a", "Yoga")] });
  });

  it("single failed task ⇒ no answer, no clarification", () => {
    expect(compose({ tasks: [failed("a", "Yoga")], deferred: [] })).toEqual({ pending: [] });
  });

  it("multiple tasks ⇒ headed sections in task order", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T-answer"), ok("b", "Boxen in München", "B-answer")], deferred: [] });
    expect(r.answer).toBe("**Tennis in Dortmund**\nT-answer\n\n**Boxen in München**\nB-answer");
    expect(r.clarification).toBeUndefined();
  });

  it("a pending task gets one question after the sections and is returned in pending", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T"), pending("b", "Rückenschmerzen"), ok("c", "Boxen in München", "B")], deferred: [] });
    const q = clarificationFor(["Rückenschmerzen"]);
    expect(q).toBe("Kurze Frage, bevor ich weitersuche 😄 – für „Rückenschmerzen“: in welcher Stadt (oder Umgebung) soll ich schauen?");
    expect(r.answer).toBe(`**Tennis in Dortmund**\nT\n\n**Boxen in München**\nB\n\n${q}`);
    expect(r.clarification).toBe(q);
    expect(r.pending.map((p) => p.id)).toEqual(["b"]);
  });

  it("two pending tasks share one question", () => {
    expect(clarificationFor(["Tennis", "Boxen"])).toContain("für „Tennis“ und „Boxen“");
  });

  it("deferred tasks are noted last", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T")], deferred: [task("d", "Klettern in Köln"), task("e", "Schwimmen in Essen")] });
    expect(deferredNote(["Klettern in Köln", "Schwimmen in Essen"])).toBe("(Notiert für danach: Klettern in Köln, Schwimmen in Essen – sag einfach Bescheid, dann suche ich weiter.)");
    expect(r.answer).toBe(`**Tennis in Dortmund**\nT\n\n${deferredNote(["Klettern in Köln", "Schwimmen in Essen"])}`);
  });

  it("a failed task renders a templated apology instead of vanishing", () => {
    const r = compose({ tasks: [ok("a", "Tennis in Dortmund", "T"), failed("b", "Boxen in München")], deferred: [] });
    expect(failedSection("Boxen in München")).toBe("**Boxen in München**\nBei „Boxen in München“ ist gerade etwas schiefgelaufen – versuch es gleich noch einmal.");
    expect(r.answer).toBe(`**Tennis in Dortmund**\nT\n\n${failedSection("Boxen in München")}`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/compose.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `workflow/compose.ts`**

```ts
/**
 * Pure assembly of the final answer from the per-task results. No model
 * call: the model never sees more than one task's partners, so it cannot
 * mix them up or invent a cross-task summary.
 */
import type { Task, TaskRun } from "./types";

export const CLARIFICATION = "In welcher Stadt (oder Umgebung) suchst du? Sag mir kurz den Ort, dann finde ich passende Angebote.";

export function clarificationFor(labels: string[]): string {
  return `Kurze Frage, bevor ich weitersuche 😄 – für „${labels.join("“ und „")}“: in welcher Stadt (oder Umgebung) soll ich schauen?`;
}

export function deferredNote(labels: string[]): string {
  return `(Notiert für danach: ${labels.join(", ")} – sag einfach Bescheid, dann suche ich weiter.)`;
}

export function failedSection(label: string): string {
  return `**${label}**\nBei „${label}“ ist gerade etwas schiefgelaufen – versuch es gleich noch einmal.`;
}

export function compose(args: { tasks: TaskRun[]; deferred: Task[] }): { answer?: string; clarification?: string; pending: Task[] } {
  const pending = args.tasks.filter((t) => t.status === "needs_clarification").map((t) => t.task);

  // Exactly what the single-task lab produced before stage 0 existed.
  if (args.tasks.length === 1 && args.deferred.length === 0) {
    const t = args.tasks[0]!;
    if (t.status === "ok") return { answer: t.answer, pending };
    if (t.status === "needs_clarification") return { clarification: CLARIFICATION, pending };
    return { pending };
  }

  const parts: string[] = [];
  for (const t of args.tasks) {
    if (t.status === "ok") parts.push(`**${t.task.label}**\n${t.answer ?? ""}`);
    else if (t.status === "failed") parts.push(failedSection(t.task.label));
  }
  let clarification: string | undefined;
  if (pending.length) {
    clarification = clarificationFor(pending.map((p) => p.label));
    parts.push(clarification);
  }
  if (args.deferred.length) parts.push(deferredNote(args.deferred.map((d) => d.label)));
  return { answer: parts.join("\n\n"), ...(clarification ? { clarification } : {}), pending };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/compose.test.ts` → PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add workflow/compose.ts tests/compose.test.ts
git commit -m "v3: pure compose of per-task answers, clarification question and deferred note"
```

---

### Task 6: Runner — `runTask`, stage 0, pool of `maxTasksPerTurn`, status, compose

**Files:**
- Modify: `workflow/run-workflow.ts`
- Test: `tests/run-workflow.test.ts`

**Interfaces:**
- Consumes: `decompose` (Task 3), `detectCity` hint (Task 4), `compose`/`CLARIFICATION` (Task 5), `runWithLimit` (`lib/reused/limiter.ts`).
- Produces: `runWorkflow(input, overrides?, deps?): Promise<WorkflowTrace>` with the Task 2 trace shape; `runTask(task, input, ctx, cityHint): Promise<TaskRun>` (exported for tests). `CLARIFICATION` is re-exported from `run-workflow.ts` so existing imports keep working.

Status rule: all tasks failed ⇒ `failed`; some failed ⇒ `partial`; else any pending ⇒ `needs_clarification`; else `ok`. `error` on `failed`: single task ⇒ that task's error (already `"<Stage title>: <msg>"`); several ⇒ `"<label>: <msg>"` joined by `"; "`. The hint passed to stage 1 is `task.cityMention` unless stage 0 degraded (then `undefined`, so stage 1 asks the model as before).

- [ ] **Step 1: Write the failing tests**

Replace the imports at the top of `tests/run-workflow.test.ts` with:
```ts
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";
import { deps, fakeBackend, fakeEmbed, fakeLlm, rawTask, resolveKnownCity, ruhrWorld, CENTROIDS } from "./_fakes";
import type { Task } from "../workflow/types";
```
Keep every existing test unchanged, and add this second `describe` block at the end of the file:
```ts
const T = (query: string, cityMention: string | null = null, priority = 1) => rawTask({ label: query, query, cityMention, priority });
const task = (id: string, query: string): Task => ({ id, label: query, query, cityMention: null, priority: 1 });

/** A world that resolves Dortmund/Bochum/Essen and records how many tasks are inside resolveCityFuzzy at once. */
function slowWorld(delayMs = 30) {
  let inFlight = 0, peak = 0;
  const backend = fakeBackend({
    resolveCityFuzzy: async (place) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return resolveKnownCity(place);
    },
    cityCentroids: CENTROIDS,
    matchPartners: () => [],
    getPartnerProfiles: () => [],
  });
  return { backend, peak: () => peak };
}

describe("runWorkflow — multi-task", () => {
  it("single task: trace has decompose + one TaskRun, and stages/answer are the classic single-run shape", async () => {
    const t = await runWorkflow({ query: Q }, { maxNearbyHubs: 0 }, happy());
    expect(t.decompose.status).toBe("ok");
    expect(t.tasks).toHaveLength(1);
    expect(t.tasks[0]!.status).toBe("ok");
    expect(t.stages).toBe(t.tasks[0]!.stages);
    expect(t.stages.map((s) => s.id)).toEqual(["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"]);
    expect(t.answer).toBe("**Gefunden.**");
    expect(t.deferred).toEqual([]);
    expect(t.pending).toEqual([]);
    // stage 0's hint means stage 1 never called the detect model
    expect((t.stages[0]!.config as { cityMentionSource: string }).cityMentionSource).toBe("hint");
  });

  it("runs three tasks concurrently (peak in-flight = 3) and composes three sections", async () => {
    const world = slowWorld();
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2), T("Yoga in Essen", "Essen", 3)], answer: (p) => `A:${/Gesuchte Stadt: (\w+)/.exec(p)?.[1]}` });
    const t = await runWorkflow({ query: "drei Dinge" }, { maxNearbyHubs: 0, maxNearbyCities: 0 }, deps({ llm, backend: world.backend }));
    expect(t.status).toBe("ok");
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
    expect(world.peak()).toBe(3);
    expect(t.answer).toBe("**Tennis in Dortmund**\nA:Dortmund\n\n**Boxen in Bochum**\nA:Bochum\n\n**Yoga in Essen**\nA:Essen");
    expect(t.stages).toEqual([]);
    expect(t.tasks[1]!.stages[0]!.input).toMatchObject({ query: "Boxen in Bochum", cityMention: "Bochum" });
  });

  it("never runs more than maxTasksPerTurn: the rest is deferred and named in the answer", async () => {
    const world = slowWorld();
    const five = [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2), T("Yoga in Essen", "Essen", 3), T("Klettern in Köln", "Köln", 4), T("Schwimmen in Essen", "Essen", 5)];
    const t = await runWorkflow({ query: "fünf Dinge" }, { maxNearbyHubs: 0, maxNearbyCities: 0 }, deps({ llm: fakeLlm({ decompose: five }), backend: world.backend }));
    expect(t.tasks).toHaveLength(3);
    expect(world.peak()).toBeLessThanOrEqual(3);
    expect(t.deferred.map((d) => d.query)).toEqual(["Klettern in Köln", "Schwimmen in Essen"]);
    expect(t.answer).toContain("(Notiert für danach: Klettern in Köln, Schwimmen in Essen");
    expect(t.status).toBe("ok");
  });

  it("maxTasksPerTurn=2 with three tasks ⇒ peak 2, one deferred", async () => {
    const world = slowWorld();
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2), T("Yoga in Essen", "Essen", 3)] });
    const t = await runWorkflow({ query: "x" }, { maxTasksPerTurn: 2, maxNearbyHubs: 0, maxNearbyCities: 0 }, deps({ llm, backend: world.backend }));
    expect(t.tasks).toHaveLength(2);
    expect(world.peak()).toBe(2);
    expect(t.deferred).toHaveLength(1);
  });

  it("one task without a city ⇒ the others finish, status needs_clarification, the task is returned as pending", async () => {
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Rückenschmerzen", null, 3), T("Boxen in Bochum", "Bochum", 2)], answer: "A" });
    const t = await runWorkflow({ query: "x" }, { maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.status).toBe("needs_clarification");
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "ok", "needs_clarification"]);
    expect(t.pending.map((p) => p.label)).toEqual(["Rückenschmerzen"]);
    expect(t.clarification).toMatch(/für „Rückenschmerzen“/);
    expect(t.answer).toBe(`**Tennis in Dortmund**\nA\n\n**Boxen in Bochum**\nA\n\n${t.clarification}`);
    expect(t.tasks[2]!.stages.slice(1).every((s) => s.status === "skipped")).toBe(true);
  });

  it("one task failing while another succeeds ⇒ partial, with the failed section and the error mirrored", async () => {
    const backend = ruhrWorld({ failCities: [] });
    let n = 0;
    const embed = async (text: string) => { n++; if (text.includes("Boxen")) throw new Error("embed down"); return (await fakeEmbed()(text)); };
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2)], reformulated: (q) => q, answer: "A" });
    const t = await runWorkflow({ query: "x" }, { maxNearbyHubs: 0 }, deps({ llm, backend, embed }));
    expect(n).toBe(2);
    expect(t.status).toBe("partial");
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "failed"]);
    expect(t.answer).toContain("Bei „Boxen in Bochum“ ist gerade etwas schiefgelaufen");
    expect(t.error?.message).toMatch(/Boxen in Bochum: .*embed down/);
  });

  it("all tasks failing ⇒ failed", async () => {
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2)] });
    const t = await runWorkflow({ query: "x" }, {}, deps({ llm, embed: fakeEmbed(undefined, new Error("embed down")) }));
    expect(t.status).toBe("failed");
    expect(t.answer).toBeUndefined();
    expect(t.error?.message).toMatch(/Tennis in Dortmund: .*embed down; Boxen in Bochum: .*embed down/);
  });

  it("enableDecomposition=false ⇒ stage 0 skipped, one task, stage 1 asks the model", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund", decompose: [T("nie", "Essen")] });
    const t = await runWorkflow({ query: Q }, { enableDecomposition: false, maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.decompose.status).toBe("skipped");
    expect(t.tasks).toHaveLength(1);
    expect(llm.calls.map((c) => c.fn)).toContain("detectCity");
    expect(t.tasks[0]!.stages[0]!.output).toMatchObject({ target: { canonical: "Dortmund" } });
  });

  it("a degraded decomposition lets stage 1 ask the model (no null hint)", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund", failDecompose: new Error("model down") });
    const t = await runWorkflow({ query: Q }, { maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.decompose.status).toBe("warning");
    expect(t.status).toBe("ok");
    expect(llm.calls.map((c) => c.fn)).toContain("detectCity");
  });

  it("resume: deferred tasks run first, a pending task is merged and re-run", async () => {
    const resume = { pending: [task("p1", "Tennis")], deferred: [task("d1", "Yoga in Essen")] };
    const llm = fakeLlm({
      decompose: (_q, pending) => [rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", resolvesPending: pending[0]!.id })],
      cityMention: (q) => (q.includes("Essen") ? "Essen" : null),
      answer: "A",
    });
    const t = await runWorkflow({ query: "Dortmund", resume }, { maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.decompose.input).toMatchObject({ pending: ["p1"], deferred: ["d1"] });
    expect(t.tasks.map((x) => x.task.id)).toEqual(["d1", "p1"]);
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(t.pending).toEqual([]);
  });

  it("invalid config ⇒ failed with an empty task list and a skipped stage 0", async () => {
    const t = await runWorkflow({ query: Q }, { maxTasksPerTurn: 9 }, happy());
    expect(t.status).toBe("failed");
    expect(t.tasks).toEqual([]);
    expect(t.decompose.status).toBe("skipped");
    expect(t.error?.message).toMatch(/maxTasksPerTurn/);
  });
});
```
Note on hints: a carried deferred task (e.g. `d1` above) comes from `resume`, not from this turn's model call, so its `cityMention: null` must NOT be passed to stage 1 as a hint (that would skip the model and miss "Essen"). The runner therefore passes a hint only for ids in `DecomposeOutput.fresh` and only when stage 0 did not degrade; every other task gets `undefined` and stage 1 asks the model as before.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/run-workflow.test.ts` → the new block FAILS (`t.decompose` is `skipped`, `t.tasks` empty, etc.).

- [ ] **Step 3: Rewrite `workflow/run-workflow.ts`**

```ts
/**
 * workflow/run-workflow.ts — the runner.
 * Stage 0 splits the message into tasks; each runnable task then goes
 * through stages 1–6 (`runTask`, strictly in order) inside a pool of at
 * most `maxTasksPerTurn` (≤ 3). Every stage becomes a StageRecord; the
 * per-task answers are composed by pure code. The runner NEVER throws.
 */
import { randomUUID } from "node:crypto";
import { resolveConfig, type WorkflowConfig } from "../config/workflow.config";
import { runWithLimit } from "../lib/reused/limiter";
import { compose, CLARIFICATION } from "./compose";
import { decompose } from "./stages/0-decompose";
import { detectCity } from "./stages/1-detect-city";
import { reformulate } from "./stages/2-reformulate";
import { nearbyCities } from "./stages/3-nearby-cities";
import { search } from "./stages/4-search";
import { rerank } from "./stages/5-rerank";
import { respond } from "./stages/6-respond";
import type { StageContext, StageId, StageRecord, StageResult, Task, TaskRun, WorkflowDeps, WorkflowInput, WorkflowStatus, WorkflowTrace } from "./types";

export { CLARIFICATION };

const TITLES: Record<StageId, string> = {
  decompose: "Decompose message",
  "detect-city": "Detect city", reformulate: "Reformulate question", "nearby-cities": "Find nearby cities",
  search: "Embed once + similarity search", rerank: "Combine, dedupe, rerank", respond: "Final response",
};
const TASK_ORDER: StageId[] = ["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"];

function skipped(id: StageId): StageRecord {
  return { id, title: TITLES[id], status: "skipped", durationMs: 0, input: null, config: {}, warnings: [] };
}

async function runStage<I, O>(id: StageId, input: I, fn: () => Promise<StageResult<O>>): Promise<{ record: StageRecord<I, O>; result?: StageResult<O> }> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const warnings = result.warnings ?? [];
    return {
      record: {
        id, title: TITLES[id], status: warnings.length ? "warning" : "ok", durationMs: Math.round(performance.now() - t0),
        input, output: result.output, config: result.config, ...(result.filters ? { filters: result.filters } : {}), ...(result.counts ? { counts: result.counts } : {}), warnings,
      },
      result,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { record: { id, title: TITLES[id], status: "error", durationMs: Math.round(performance.now() - t0), input, config: {}, warnings: [], error: { message } } };
  }
}

/**
 * Stages 1–6 for ONE task. `cityHint` is stage 0's cityMention for this task
 * (undefined ⇒ stage 1 asks the model itself). Never throws.
 */
export async function runTask(task: Task, input: WorkflowInput, ctx: StageContext, cityHint: string | null | undefined): Promise<TaskRun> {
  const t0 = performance.now();
  const stages: StageRecord[] = [];
  const skipRest = () => { for (const id of TASK_ORDER.slice(stages.length)) stages.push(skipped(id)); };
  const stageError = (record: StageRecord): { message: string } | undefined =>
    record.error && { message: `${record.title}: ${record.error.message}` };
  const done = (partial: Partial<TaskRun> & { status: TaskRun["status"] }): TaskRun =>
    ({ task, totalMs: Math.round(performance.now() - t0), stages, ...partial });
  const query = task.query;

  // 1
  const s1 = await runStage("detect-city", { query, homeCity: input.homeCity, sessionCities: input.sessionCities, cityMention: cityHint },
    () => detectCity({ query, homeCity: input.homeCity, sessionCities: input.sessionCities, cityMention: cityHint }, ctx));
  stages.push(s1.record);
  if (!s1.result) { skipRest(); return done({ status: "failed", error: stageError(s1.record) }); }
  const target = s1.result.output.target;
  if (!target) { skipRest(); return done({ status: "needs_clarification", clarification: CLARIFICATION }); }

  // 2
  const s2 = await runStage("reformulate", { query }, () => reformulate({ query }, ctx));
  stages.push(s2.record);
  if (!s2.result) { skipRest(); return done({ status: "failed", error: stageError(s2.record) }); }
  const retrievalQuery = s2.result.output.retrievalQuery;

  // 3
  const s3 = await runStage("nearby-cities", { target: target.canonical, centroid: target.centroid }, () => nearbyCities({ target }, ctx));
  stages.push(s3.record);
  if (!s3.result) { skipRest(); return done({ status: "failed", error: stageError(s3.record) }); }
  const cities = s3.result.output.cities;

  // 4 — `queryEmbedding` is captured via closure so stage 5 reuses the same
  // vector without re-embedding; it is assigned before the wrapped promise
  // resolves, and only on success (a throw skips stage 5 anyway).
  let queryEmbedding: number[] = [];
  const s4 = await runStage("search", { retrievalQuery, cities: cities.map((c) => c.city) }, async () => {
    const r = await search({ retrievalQuery, cities }, ctx);
    queryEmbedding = r.queryEmbedding;
    return r;
  });
  stages.push(s4.record);
  if (!s4.result) { skipRest(); return done({ status: "failed", error: stageError(s4.record) }); }

  // 5
  const candidates = s4.result.output.candidates;
  const s5 = await runStage("rerank", { candidates: candidates.length }, () => rerank({ candidates, queryEmbedding }, ctx));
  stages.push(s5.record);
  if (!s5.result) { skipRest(); return done({ status: "failed", error: stageError(s5.record) }); }

  // 6
  const kept = s5.result.output.kept;
  const s6 = await runStage("respond", { query, targetCity: target.canonical, kept: kept.map((k) => k.id) }, () => respond({ query, targetCity: target.canonical, kept }, ctx));
  stages.push(s6.record);
  if (!s6.result) return done({ status: "failed", error: stageError(s6.record) });

  return done({ status: "ok", answer: s6.result.output.answer, recommendations: s6.result.output.recommendations });
}

function overallStatus(tasks: TaskRun[]): WorkflowStatus {
  const s = tasks.map((t) => t.status);
  if (s.length && s.every((x) => x === "failed")) return "failed";
  if (s.some((x) => x === "failed")) return "partial";
  if (s.some((x) => x === "needs_clarification")) return "needs_clarification";
  return "ok";
}

export async function runWorkflow(input: WorkflowInput, overrides: Partial<WorkflowConfig> = {}, deps?: WorkflowDeps): Promise<WorkflowTrace> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const runId = randomUUID();
  const done = (partial: Partial<WorkflowTrace> & { status: WorkflowStatus; config: WorkflowConfig }): WorkflowTrace =>
    ({ runId, startedAt, totalMs: Math.round(performance.now() - t0), input, decompose: skipped("decompose"), tasks: [], deferred: [], pending: [], stages: [], ...partial });

  let config: WorkflowConfig;
  try {
    config = resolveConfig(overrides);
  } catch (e) {
    return done({ status: "failed", config: { ...(overrides as WorkflowConfig) }, error: { message: (e as Error).message } });
  }
  // `createDeps()` builds the real ports and throws synchronously when the
  // Azure / Supabase / embedding credentials are missing. That must become a
  // failed trace, not an exception escaping the runner.
  let d: WorkflowDeps;
  try {
    d = deps ?? (await import("./deps")).createDeps();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return done({ status: "failed", config, error: { message: `dependencies: ${message}` } });
  }
  const ctx: StageContext = { config, deps: d, signal: AbortSignal.timeout(config.runTimeoutMs) };

  // 0 — disabled ⇒ recorded as skipped, but the split still happens (one task).
  const resume = input.resume;
  const s0 = await runStage("decompose", { query: input.query, pending: resume?.pending.map((p) => p.id) ?? [], deferred: resume?.deferred.map((d) => d.id) ?? [] },
    () => decompose({ query: input.query, resume }, ctx));
  if (!s0.result) return done({ status: "failed", config, decompose: s0.record, error: { message: `${s0.record.title}: ${s0.record.error?.message}` } });
  const decomposeRecord = config.enableDecomposition ? s0.record : skipped("decompose");
  const { runnable, deferred, degraded, fresh } = s0.result.output;
  const freshIds = new Set(fresh);

  // 1–6 per task, at most maxTasksPerTurn at once. runTask never throws, but
  // a rejection here would otherwise lose the task silently.
  const settled = await runWithLimit(
    runnable.map((task) => () => runTask(task, input, ctx, freshIds.has(task.id) && !degraded ? task.cityMention : undefined)),
    config.maxTasksPerTurn,
  );
  const tasks: TaskRun[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { task: runnable[i]!, status: "failed", totalMs: 0, stages: TASK_ORDER.map(skipped), error: { message: s.reason instanceof Error ? s.reason.message : String(s.reason) } },
  );

  const status = overallStatus(tasks);
  const composed = compose({ tasks, deferred });
  const failed = tasks.filter((t) => t.status === "failed");
  const error =
    status === "failed" || status === "partial"
      ? tasks.length === 1
        ? failed[0]!.error
        : { message: failed.map((t) => `${t.task.label}: ${t.error?.message ?? "failed"}`).join("; ") }
      : undefined;

  return done({
    status, config, decompose: decomposeRecord, tasks, deferred, pending: composed.pending,
    stages: tasks.length === 1 ? tasks[0]!.stages : [],
    ...(composed.answer !== undefined ? { answer: composed.answer } : {}),
    ...(tasks.length === 1 && tasks[0]!.recommendations ? { recommendations: tasks[0]!.recommendations } : {}),
    ...(composed.clarification ? { clarification: composed.clarification } : {}),
    ...(error ? { error } : {}),
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → ALL PASS (old runner tests included — check especially `"returns a failed trace (not a throw) on an invalid config"` still sees `t.stages` `[]`, and `"stops with needs_clarification"` still sees 6 stages with `stages[0].status === "warning"`). `npm run typecheck` → clean.

If the "single task" test's `cityMentionSource === "hint"` assertion fails, check that `happy()`'s fake decompose returns `cityMention: "Dortmund"` (it does via the `cityMention` option) and that `fresh` contains the task id.

- [ ] **Step 5: Commit**

```bash
git add workflow/run-workflow.ts workflow/types.ts workflow/stages/0-decompose.ts tests/run-workflow.test.ts tests/stage0-decompose.test.ts
git commit -m "v3: runner splits the message (stage 0), runs up to 3 tasks in parallel, defers the rest, composes the answer"
```

---

### Task 7: API route accepts `resume`

**Files:**
- Modify: `app/api/workflow/route.ts`
- Test: `tests/api-route.test.ts`

**Interfaces:**
- Produces: `POST` body `resume?: { pending: Task[]; deferred: Task[] }` (each list ≤ 10; `id` 1–40 chars, `label` ≤ 60, `query` 1–2000, `cityMention` ≤ 100 or null, `priority` number) forwarded as `input.resume`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api-route.test.ts` inside the `describe`:
```ts
  it("forwards resume state", async () => {
    const resume = { pending: [{ id: "p1", label: "Tennis", query: "Tennis", cityMention: null, priority: 1 }], deferred: [] };
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "Dortmund", resume }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).input.resume).toEqual(resume);
  });
  it("400 on a malformed resume task", async () => {
    const res = await POST(new Request("http://x/api/workflow", { method: "POST", body: JSON.stringify({ query: "x", resume: { pending: [{ id: "", label: "", query: "", cityMention: null, priority: 1 }], deferred: [] } }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resume/);
  });
```
Also change the existing `"200 with the trace"` expectation to `expect(body.input).toEqual({ query: "Yoga in Bochum", homeCity: "Essen", sessionCities: undefined, resume: undefined });`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/api-route.test.ts` → FAIL (`resume` stripped; malformed resume returns 200).

- [ ] **Step 3: Implement**

In `app/api/workflow/route.ts`, replace `bodySchema` with:
```ts
const taskSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().max(60),
  query: z.string().trim().min(1).max(2000),
  cityMention: z.string().trim().max(100).nullable(),
  priority: z.number(),
});
const bodySchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2000),
  homeCity: z.string().trim().max(100).optional(),
  sessionCities: z.array(z.string().trim().max(100)).max(20).optional(),
  resume: z.object({ pending: z.array(taskSchema).max(10), deferred: z.array(taskSchema).max(10) }).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
```
and the `POST` body:
```ts
  const { query, homeCity, sessionCities, resume, config } = parsed.data;
  const trace = await runWorkflow({ query, homeCity: homeCity || undefined, sessionCities, resume }, (config ?? {}) as Parameters<typeof runWorkflow>[1]);
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/api-route.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/workflow/route.ts tests/api-route.test.ts
git commit -m "v3: /api/workflow accepts resume state (pending + deferred tasks)"
```

---

### Task 8: CLI output for multi-task runs

**Files:**
- Modify: `scripts/run.ts`

No unit test (the CLI is a thin printer); verified by running it.

- [ ] **Step 1: Replace the output block**

In `scripts/run.ts`, replace everything from `for (const s of trace.stages) {` to the end with:
```ts
function printStages(stages: typeof trace.stages, indent = ""): void {
  for (const s of stages) {
    console.log(`${indent}[${s.status.toUpperCase()}] ${s.title} (${s.durationMs} ms)`);
    if (s.counts) console.log(`${indent}  counts:`, JSON.stringify(s.counts));
    for (const w of s.warnings) console.log(`${indent}  ⚠`, w);
    if (s.error) console.log(`${indent}  ✖`, s.error.message);
  }
}

console.log("");
printStages([trace.decompose]);
for (const t of trace.tasks) {
  console.log(`\n── task ${t.task.id} · ${t.task.label} · ${t.status} · ${t.totalMs} ms`);
  printStages(t.stages, "  ");
}
console.log(`\nstatus: ${trace.status} · ${trace.totalMs} ms · ${trace.tasks.length} task(s) run, ${trace.deferred.length} deferred, ${trace.pending.length} pending`);
if (trace.error) console.log("✖", trace.error.message);
if (trace.clarification) console.log(trace.clarification);
if (trace.answer) console.log("\n" + trace.answer);
if (trace.deferred.length) console.log("\ndeferred:", trace.deferred.map((d) => d.label).join(", "));
if (trace.pending.length) console.log("pending:", trace.pending.map((p) => p.label).join(", "));
if (json) console.log(JSON.stringify(trace, null, 2));
if (trace.status !== "ok") process.exit(1);
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck` → clean. If `.env.local` has credentials, run
`npm run workflow -- "Tennis in Dortmund und Boxen in Bochum"` and confirm two `── task` blocks and a two-section answer; without credentials confirm it prints `status: failed` with the `dependencies:` error and exits 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/run.ts
git commit -m "v3: CLI prints stage 0, per-task stages, deferred and pending"
```

---

### Task 9: Dev UI — decompose section, task strip, resume chip

**Files:**
- Create: `components/TaskStrip.tsx`, `components/stages/DecomposeView.tsx`
- Modify: `app/page.tsx`, `components/QueryForm.tsx`, `lib/ui/format.ts`, `lib/ui/examples.ts`

**Interfaces:**
- Consumes: `WorkflowTrace.decompose / tasks / deferred / pending`, `DecomposeOutput`.
- Produces: `TaskStrip({ tasks, selected, onSelect })`, `DecomposeView({ output })`, `QueryForm` props `resume: ResumeState | null; onClearResume: () => void`.

- [ ] **Step 1: `lib/ui/format.ts`** — add `case "partial":` to the amber group:
```ts
    case "warning": case "needs_clarification": case "partial": return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
```
Also add a test line to `tests/ui-format.test.ts` inside its existing `describe` (open the file to match its style; if it tests `statusColor`, add `expect(statusColor("partial")).toMatch(/amber/);`).

- [ ] **Step 2: `lib/ui/examples.ts`** — append two examples:
```ts
  "Tennis in Dortmund, Boxen in Bochum und etwas gegen Rückenschmerzen in Essen",
  "Yoga in Bochum, Klettern in Dortmund, Schwimmen in Essen, Reha-Sport in Hagen und Tennis in Lünen",
```

- [ ] **Step 3: Create `components/stages/DecomposeView.tsx`**
```tsx
"use client";
import type { DecomposeOutput } from "../../workflow/types";
import { NUM, TABLE, TD, TH, TableWrap } from "./_table";

export function DecomposeView({ output }: { output: DecomposeOutput }) {
  const slot = (id: string) => (output.runnable.some((t) => t.id === id) ? "run now" : "deferred");
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {output.tasks.length} task(s) · {output.runnable.length} run now · {output.deferred.length} deferred
        {output.degraded ? <span className="text-amber-700 dark:text-amber-300"> · degraded (whole message = one task)</span> : null}
        {output.model ? <span className="text-zinc-500"> · {output.model}</span> : null}
      </p>
      <TableWrap>
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={`${TH} text-right`}>Prio</th><th className={TH}>Id</th><th className={TH}>Label</th><th className={TH}>Query</th><th className={TH}>City mention</th><th className={TH}>Slot</th>
            </tr>
          </thead>
          <tbody>
            {output.tasks.map((t) => (
              <tr key={t.id} className={slot(t.id) === "deferred" ? "opacity-60" : ""}>
                <td className={NUM}>{t.priority}</td>
                <td className={`${TD} font-mono text-xs`}>{t.id}</td>
                <td className={TD}>{t.label}</td>
                <td className={TD}>{t.query}</td>
                <td className={TD}>{t.cityMention ?? <span className="text-zinc-400">—</span>}</td>
                <td className={TD}>{slot(t.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
```

- [ ] **Step 4: Create `components/TaskStrip.tsx`**
```tsx
"use client";
import type { TaskRun } from "../workflow/types";
import { statusColor } from "../lib/ui/format";

/** One chip per executed task: label · status · ms. Selecting one shows its stages below. */
export function TaskStrip({ tasks, selected, onSelect }: { tasks: TaskRun[]; selected: number; onSelect: (i: number) => void }) {
  if (tasks.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold uppercase tracking-wide text-zinc-500">Tasks</span>
      {tasks.map((t, i) => (
        <button
          key={t.task.id}
          type="button"
          onClick={() => onSelect(i)}
          aria-pressed={i === selected}
          className={`flex items-center gap-2 rounded-full border px-3 py-1 ${i === selected ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "border-zinc-300 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"}`}
        >
          <span className="font-semibold">{t.task.label}</span>
          <span className={`rounded px-1.5 py-0.5 font-medium ${statusColor(t.status)}`}>{t.status}</span>
          <span className="tabular-nums text-zinc-500">{t.totalMs} ms</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: `components/QueryForm.tsx`** — add the resume chip

Extend the props:
```ts
import type { ResumeState } from "../workflow/types";
export interface QueryFormProps {
  query: string; setQuery: (q: string) => void;
  homeCity: string; setHomeCity: (c: string) => void;
  running: boolean; onRun: () => void;
  resume: ResumeState | null; onClearResume: () => void;
}
```
Destructure `resume, onClearResume` in the component and render, directly under the example-query buttons `<div>`:
```tsx
      {resume && (resume.pending.length > 0 || resume.deferred.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">Weiter mit:</span>
          <span>{resume.pending.length} offen{resume.pending.length ? ` (${resume.pending.map((p) => p.label).join(", ")})` : ""}</span>
          <span>·</span>
          <span>{resume.deferred.length} zurückgestellt{resume.deferred.length ? ` (${resume.deferred.map((d) => d.label).join(", ")})` : ""}</span>
          <button type="button" onClick={onClearResume} aria-label="Resume-Status verwerfen" className="ml-auto rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40">×</button>
        </div>
      )}
```

- [ ] **Step 6: `app/page.tsx`**

Add imports:
```ts
import type { DecomposeOutput, ResumeState, ... } from "../workflow/types";   // extend the existing type import
import ReactMarkdown from "react-markdown";
import { TaskStrip } from "../components/TaskStrip";
import { DecomposeView } from "../components/stages/DecomposeView";
```
Add state next to the others:
```ts
  const [resume, setResume] = useState<ResumeState | null>(null);
  const [taskIdx, setTaskIdx] = useState(0);
```
In `run()`, send `resume: resume ?? undefined` in the JSON body and, after `setSelected(trace.runId)`, add:
```ts
      setTaskIdx(0);
      setResume(trace.pending.length || trace.deferred.length ? { pending: trace.pending, deferred: trace.deferred } : null);
```
Replace the `trace`/`out` lines with:
```ts
  const trace = runs.find((r) => r.runId === selected);
  const taskRun = trace?.tasks[Math.min(taskIdx, Math.max(0, (trace?.tasks.length ?? 1) - 1))];
  const stages = taskRun?.stages ?? [];
  const out = <T,>(id: string) => stages.find((s) => s.id === id)?.output as T | undefined;
```
Pass the new props: `<QueryForm ... resume={resume} onClearResume={() => setResume(null)} />`.
Wrap `setSelected` for the history so the task index resets: `<RunHistory runs={runs} selected={selected} onSelect={(id) => { setSelected(id); setTaskIdx(0); }} />`.

Inside `{trace && (<> … </>)}` replace the body with:
```tsx
          <div className="flex items-center gap-3 text-sm">
            <span className={`rounded px-2 py-0.5 font-medium ${statusColor(trace.status)}`}>{trace.status}</span>
            <span>{trace.totalMs} ms</span>
            <span className="text-zinc-500">{trace.tasks.length} task(s) · {trace.deferred.length} deferred · {trace.pending.length} pending</span>
            {trace.error && <span className="text-red-700 dark:text-red-300">{trace.error.message}</span>}
            <button type="button" className="ml-auto rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" onClick={() => navigator.clipboard.writeText(JSON.stringify(trace, null, 2))}>Copy trace JSON</button>
          </div>
          {(trace.answer || trace.clarification) && (
            <div className="rounded border border-emerald-200 bg-emerald-50/40 p-4 text-sm leading-6 dark:border-emerald-900 dark:bg-emerald-950/20 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_a]:underline">
              <ReactMarkdown>{trace.answer ?? trace.clarification ?? ""}</ReactMarkdown>
            </div>
          )}
          <div id="stage-decompose" className="scroll-mt-4">
            <StageSection index={0} stage={trace.decompose}>
              {!!trace.decompose.output && <DecomposeView output={trace.decompose.output as DecomposeOutput} />}
            </StageSection>
          </div>
          <TaskStrip tasks={trace.tasks} selected={taskIdx} onSelect={setTaskIdx} />
          {taskRun && trace.tasks.length > 1 && (
            <p className="text-xs text-zinc-500">Showing task <b>{taskRun.task.label}</b> — query: <i>{taskRun.task.query}</i></p>
          )}
          <PipelineStrip stages={stages} onJump={jump} />
          {stages.map((s, i) => (
            <div key={`${trace.runId}-${taskRun?.task.id}-${s.id}`} id={`stage-${s.id}`} className="scroll-mt-4">
              <StageSection index={i + 1} stage={s}>
                {s.id === "detect-city" && !!s.output && <DetectCityView output={out<DetectCityOutput>(s.id)!} />}
                {s.id === "reformulate" && !!s.output && <ReformulateView output={out<ReformulateOutput>(s.id)!} />}
                {s.id === "nearby-cities" && !!s.output && <NearbyCitiesView output={out<NearbyCitiesOutput>(s.id)!} />}
                {s.id === "search" && !!s.output && <SearchView output={out<SearchOutput>(s.id)!} />}
                {s.id === "rerank" && !!s.output && <RerankView output={out<RerankOutput>(s.id)!} />}
                {s.id === "respond" && !!s.output && <RespondView output={out<RespondOutput>(s.id)!} />}
              </StageSection>
            </div>
          ))}
```
Update the header subtitle to `Decompose → Detect city → Reformulate → Nearby cities → Embed once + search → Rerank → Answer (≤ 3 tasks in parallel)`.

- [ ] **Step 7: Verify**

Run: `npm run typecheck` → clean; `npm test` → PASS. Then `npm run dev -- -p 3008 -H 127.0.0.1`, open `http://127.0.0.1:3008`, run the 3-task example: expect a composed answer with three bold headings, a "0. Decompose message" section listing three tasks, a task strip with three chips, and clicking a chip switches the six stage sections. Run the 5-task example: expect 2 rows marked "deferred", the "(Notiert für danach …)" line, and the amber "Weiter mit: 0 offen · 2 zurückgestellt" chip; run "und jetzt bitte weiter" and confirm the deferred pair runs first. Without credentials, verify the failed trace renders (no crash) and skip the rest.

- [ ] **Step 8: Commit**

```bash
git add components/TaskStrip.tsx components/stages/DecomposeView.tsx components/QueryForm.tsx app/page.tsx lib/ui/format.ts lib/ui/examples.ts tests/ui-format.test.ts
git commit -m "v3: dev UI shows stage 0, a task strip per run, the composed answer and a resume chip"
```

---

### Task 10: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the pipeline section**

Replace the diagram and the "Six stages" list with a "Seven stages" description: add
`0. **Decompose** — one model call splits the message into independent tasks (different activity OR place); ids are assigned by code; deferred tasks from the previous turn go first; the top \`maxTasksPerTurn\` (≤ 3) run, the rest are deferred. Model failure ⇒ the whole message is one task.` and note that stages 1–6 now run **per task**, at most 3 tasks concurrently via `runWithLimit`, and that stage 1 uses stage 0's `cityMention` hint instead of its own model call.

- [ ] **Step 2: Configuration table** — add two rows:
```
| `enableDecomposition` | `V3_ENABLE_DECOMPOSITION` | `true` | Stage 0 — off ⇒ the whole message is one task |
| `maxTasksPerTurn` | `V3_MAX_TASKS_PER_TURN` | `3` | Stage 0 — tasks run per turn AND pool concurrency; validated `1..3`, never more |
```

- [ ] **Step 3: New section "Multiple searches in one message"** (after "How the rerank works"):

Describe: the 3-task example and what the answer looks like (three bold sections); clarification (`needs_clarification`) is asked once per turn for the pending tasks' labels while the others' results are still delivered; deferred tasks are named in a closing note; the **resume contract** — the client sends back `trace.pending` and `trace.deferred` as `resume` on the next request, deferred run first, a pending task is merged when the model recognises the reply (`resolvesPending`), an unanswered pending task is dropped with a warning; `partial` status; cost line: `N tasks ⇒ 1 + 3·N chat completions (2·N when stage 1 uses the hint, i.e. normally) + N embeddings`.

- [ ] **Step 4: Error semantics** — add `partial` and adjust `needs_clarification` to "at least one task could not resolve a city; the others' answers are still in `answer`".

- [ ] **Step 5: Limits** — replace "One workflow run per chat message — there is no multi-turn session state" with "Multi-turn state is client-held (`resume`); the server stores nothing between requests." Update "Each run costs 3 chat completions + 1 embedding" to the cost line from Step 3.

- [ ] **Step 6: Dev UI** — add bullets for the composed answer card, the Decompose section, the task strip and the resume chip.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "v3: README — stage 0, parallel tasks, resume contract"
```

---

## Self-review

- **Spec coverage:** decompose stage + schema (T2/T3) · degradation (T3) · post-processing (T3) · config dials (T1) · stage-1 hint (T4) · runTask extraction + pool + shared signal (T6) · resume order (T3/T6) · trace shape incl. `stages` alias and status rule (T2/T6) · compose rules (T5) · API `resume` (T7) · dev UI (T9) · CLI (T8) · README (T10) · tests listed in the spec all have a home. Deviation from spec: no `lib/pool.ts` — the existing `runWithLimit` already does it (with `peakConcurrency`); `DecomposeOutput.fresh` added so the runner passes a city hint only for tasks the model produced this turn.
- **Placeholders:** none.
- **Type consistency:** `RawTask` (llm-port) vs `Task` (types) used consistently; `fakeLlm.decompose` returns `{ tasks: RawTask[] }`; `runTask(task, input, ctx, cityHint)` matches the runner call; `compose` returns `{ answer?, clarification?, pending }` as consumed in T6; `DecomposeOutput.fresh: string[]` is declared in T2, set in T3 and read in T6.
