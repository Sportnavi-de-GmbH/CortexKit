// V3 COPY — copied from ../partner-recommendation-agent-v2/concurrency/limiter.ts on 2026-09-14
// (only the two relative imports changed to sibling paths). V3 never imports from V2's tree.
/**
 * concurrency/limiter.ts — a small promise semaphore.
 *
 * `runWithLimit(tasks, limit)` starts at most `limit` tasks at once and
 * returns one settled result per task, in input order. Nothing else is
 * needed for bounded fan-out; no queue library, no worker threads.
 */

export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export interface LimiterStats {
  /** Highest number of tasks observed running at the same time. */
  peakConcurrency: number;
}

export async function runWithLimit<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
  stats?: LimiterStats,
): Promise<Settled<T>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`runWithLimit: limit must be >= 1 (got ${limit})`);
  const results: Settled<T>[] = new Array(tasks.length);
  let next = 0;
  let running = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      running++;
      if (stats && running > stats.peakConcurrency) stats.peakConcurrency = running;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]!() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      } finally {
        running--;
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
