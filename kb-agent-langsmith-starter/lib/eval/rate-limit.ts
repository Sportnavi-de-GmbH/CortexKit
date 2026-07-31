// Rate-limit primitives for evaluation runs (SOP §9).
//
// Two independent mechanisms, composed by scripts/run-eval.ts:
//
//  - TokenBucketPacer: proactively paces request STARTS so the estimated
//    tokens in any rolling 60s window stay under the provider's TPM quota.
//    For this agent (~41.5k-token system prompt replayed per call) TPM is the
//    binding constraint, so pacing tokens — not requests — is what actually
//    prevents 429s.
//  - withRetry: reactive recovery with exponential backoff + equal jitter for
//    the throttles and transient faults that slip through anyway. Deterministic
//    errors (4xx like content_filter) are never retried — retrying them only
//    burns quota (see evals/ISSUES.md 2026-07-27, retry fan-out incident).
//
// Clock and sleep are injectable so the logic is unit-testable without wall
// time (tests/eval-rate-limit.test.ts).

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RetryOptions {
  /** Max attempts INCLUDING the first (default 6 = 1 try + 5 retries). */
  attempts?: number;
  /** Base backoff in ms for the first retry (default 2000). */
  baseMs?: number;
  /** Backoff cap in ms (default 90_000 — a TPM window is 60s). */
  maxMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Transient ⇒ retry; deterministic ⇒ fail fast. Conservative by design. */
export function isRetryableError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 408 || (status !== undefined && status >= 500)) return true;
  if (status !== undefined && status >= 400 && status < 500) return false; // incl. content_filter (400)
  if (msg.includes("content_filter") || msg.includes("content management policy")) return false;
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("too many requests") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("503") ||
    msg.includes("502")
  );
}

/**
 * Exponential backoff with EQUAL jitter: delay ∈ [cap/2, cap] where
 * cap = min(maxMs, baseMs * 2^retryIndex). Equal jitter keeps a guaranteed
 * minimum wait (important for 60s TPM windows) while still de-synchronizing
 * concurrent workers.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    attempts = 6,
    baseMs = 2_000,
    maxMs = 90_000,
    isRetryable = isRetryableError,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(cap / 2 + random() * (cap / 2));
      onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Paces work starts so that the sum of units started within any rolling 60s
 * window stays ≤ the budget. Units are whatever you meter:
 *  - TPM pacing: budget = TPM quota, acquire(estimated_tokens) per model call;
 *  - RPM pacing: budget = RPM quota, acquire(1) per model call.
 * Azure quotas impose BOTH; run both pacers and the tighter one governs
 * (SOP §9: binding_ceiling = min(RPM, TPM / tokens_per_request)).
 *
 * Callers acquire per TURN, not per example — multi-turn samples make several
 * model calls.
 *
 * A single request larger than the whole budget is allowed only against an
 * empty window (it can never fit otherwise — waiting forever would deadlock).
 */
export class TokenBucketPacer {
  private ledger: Array<{ at: number; tokens: number }> = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly tpmBudget: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    if (tpmBudget <= 0) throw new Error("tpmBudget must be > 0");
  }

  /** Tokens currently accounted to the rolling window. */
  used(): number {
    this.prune();
    return this.ledger.reduce((s, e) => s + e.tokens, 0);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.ledger = this.ledger.filter((e) => e.at > cutoff);
  }

  async acquire(tokens: number): Promise<void> {
    // Serialize acquirers so concurrent callers can't all observe the same
    // free window and start together.
    const turn = this.queue.then(() => this.acquireSerial(tokens));
    // Keep the chain alive even if this acquirer's caller later fails.
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async acquireSerial(tokens: number): Promise<void> {
    for (;;) {
      this.prune();
      const used = this.ledger.reduce((s, e) => s + e.tokens, 0);
      const fits = used + tokens <= this.tpmBudget || (this.ledger.length === 0 && tokens > this.tpmBudget);
      if (fits) {
        this.ledger.push({ at: this.now(), tokens });
        return;
      }
      // Wait until the oldest window entry expires (plus a small buffer).
      const oldest = this.ledger[0].at;
      const waitMs = Math.max(250, oldest + this.windowMs - this.now() + 250);
      await this.sleep(waitMs);
    }
  }
}
