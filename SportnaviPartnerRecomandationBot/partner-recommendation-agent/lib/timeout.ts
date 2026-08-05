/**
 * lib/timeout.ts
 *
 * Two small, independent primitives used across the search pipeline to
 * bound worst-case latency:
 *
 *  - `withTimeout` races a promise against a deadline. Use it around a
 *    whole stage (e.g. the full find_partners pipeline) so a hang degrades
 *    to a graceful fallback instead of blocking the turn indefinitely.
 *  - `timeoutSignal` produces an `AbortSignal` for a single external call
 *    (Supabase's `.abortSignal(...)`, the AI SDK's `embed({ abortSignal })`,
 *    or a raw `fetch`). Prefer this at the call site over `withTimeout` when
 *    the callee actually supports cancellation — it frees the underlying
 *    socket instead of merely abandoning the promise.
 *
 * Neither primitive retries. Both are deliberately dumb: the caller decides
 * what "timed out" means for its own contract (see agent/tools/find_partners.ts
 * and agent/tools/get_partner_details.ts, which both degrade to their
 * existing honest-unknown response shapes rather than throwing raw errors
 * at the model).
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms deadline`);
    this.name = "TimeoutError";
  }
}

/**
 * Rejects with a {@link TimeoutError} if `p` has not settled within `ms`.
 * Does not cancel `p` itself — pair with `timeoutSignal` at the call sites
 * that support real cancellation so the underlying work actually stops.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * `AbortSignal.timeout(ms)` wrapped in one place so every call site shares
 * the same construction and this is the one spot to swap the strategy
 * (e.g. to a shared `AbortController` per request) if that's ever needed.
 */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
