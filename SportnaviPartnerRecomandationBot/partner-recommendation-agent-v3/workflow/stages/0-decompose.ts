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
  const usedIds = new Set<string>();
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
    const id = r.resolvesPending && pendingIds.has(r.resolvesPending) && !usedIds.has(r.resolvesPending) ? r.resolvesPending : newTaskId();
    usedIds.add(id);
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
