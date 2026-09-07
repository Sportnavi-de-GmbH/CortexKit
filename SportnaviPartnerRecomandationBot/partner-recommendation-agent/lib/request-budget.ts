/**
 * lib/request-budget.ts
 *
 * Per-turn execution budget — the enforcement backstop for "no ceiling on
 * reasoning steps / tool calls per turn" (production-readiness review,
 * item 1/3). eve has no `stopWhen`/`maxSteps` primitive and its hooks are
 * observe-only (cannot block a tool call or abort a turn), so this module
 * is the actual enforcement point: tools call `recordToolCallStart` as the
 * very first thing in `execute()` and degrade to their existing
 * honest-unknown response shape when it says no. See
 * agent/tools/find_partners.ts and agent/tools/get_partner_details.ts.
 *
 * Bookkeeping (model-step counts, token usage) is fed in from
 * `agent/hooks/budget.ts`, which observes `step.completed` events — a tool
 * can't see how many model steps have already run in this turn, only eve's
 * hook stream can.
 *
 * Keyed by `session.id`, reset on the turn's first `message.received`
 * (mirrors `lib/langsmith.ts`'s `TurnJournal` reset pattern) and swept via
 * `lib/cache.ts`'s TTL cache so a missed `turn.completed`/`turn.failed`
 * cleanup can't leak state forever — same helper `search-cache.ts` uses.
 */

import { createTtlCache } from "./cache";

export interface RequestBudgetLimits {
  /** Normal path is exactly 1 (find_partners) or 1 (get_partner_details). */
  maxToolCalls: number;
  /** Normal path is exactly 2 model steps for a search, 1 otherwise (CLAUDE.md §4.1). */
  maxModelSteps: number;
  /** Measured p50-p90 for a search was 7-27s; this is the hard outer ceiling. */
  maxWallClockMs: number;
  /** Covers the current wide-context config's measured ~42k tokens/search with headroom. */
  maxTokensPerTurn: number;
  /** Computed from raw usage x list price below — NOT LangSmith's cost figure,
   *  which CLAUDE.md §9 documents as ~8x wrong (double-count + ignored cache discount). */
  maxEstimatedCostUsd: number;
}

export const DEFAULT_REQUEST_BUDGET: RequestBudgetLimits = {
  maxToolCalls: 3,
  maxModelSteps: 4,
  maxWallClockMs: 20_000,
  maxTokensPerTurn: 80_000,
  maxEstimatedCostUsd: 0.15,
};

/**
 * gpt-4o-mini list price (Azure OpenAI, per-token), deliberately NOT applying
 * the ~93% prompt-cache discount this agent actually gets — a conservative
 * over-estimate is the safe direction for a budget check that exists to
 * catch runaway cost, not to reconcile a bill.
 *
 * MUST track AZURE_AI_CHATBOT_DEPLOYMENT_NAME. Left at gpt-4.1's $2/$8 while
 * running gpt-4o-mini, this over-estimates by ~13x, so `maxEstimatedCostUsd`
 * would trip on a normal turn and degrade it to the needsClarification path.
 */
const LIST_PRICE_PER_INPUT_TOKEN_USD = 0.15 / 1_000_000;
const LIST_PRICE_PER_OUTPUT_TOKEN_USD = 0.6 / 1_000_000;

export interface BudgetState {
  toolCalls: number;
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  startedAtMs: number;
  knownPartnerNames: string[];
}

function emptyState(now: number): BudgetState {
  return {
    toolCalls: 0,
    modelSteps: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    startedAtMs: now,
    knownPartnerNames: [],
  };
}

/** 10 minutes — well past any realistic turn; a pure safety net against a
 *  missed turn.completed/turn.failed cleanup call, not the real reset path. */
const BUDGET_TTL_SEC = 600;

const store = createTtlCache<BudgetState>(BUDGET_TTL_SEC, () => Date.now(), 1000);

function stateFor(sessionId: string, now: () => number = Date.now): BudgetState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const fresh = emptyState(now());
  store.set(sessionId, fresh);
  return fresh;
}

/** Call on the turn's `message.received` — starts a fresh budget window. */
export function resetBudget(sessionId: string, now: () => number = Date.now): void {
  store.set(sessionId, emptyState(now()));
}

/** Call on `turn.completed` / `turn.failed` / `session.failed`. */
export function clearBudget(sessionId: string): void {
  store.set(sessionId, emptyState(Date.now()));
}

/** Call from the `step.completed` hook handler with that step's usage. */
export function recordModelStep(
  sessionId: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  now: () => number = Date.now,
): void {
  const s = stateFor(sessionId, now);
  s.modelSteps += 1;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  s.inputTokens += inputTokens;
  s.outputTokens += outputTokens;
  s.estimatedCostUsd +=
    inputTokens * LIST_PRICE_PER_INPUT_TOKEN_USD + outputTokens * LIST_PRICE_PER_OUTPUT_TOKEN_USD;
  store.set(sessionId, s);
}

/** Record this turn's shortlist names so the grounding tripwire (step 7 of
 *  the plan) has something to check the final reply against. */
export function recordKnownNames(sessionId: string, names: string[]): void {
  const s = stateFor(sessionId);
  s.knownPartnerNames = [...s.knownPartnerNames, ...names];
  store.set(sessionId, s);
}

export function getBudgetSnapshot(sessionId: string): BudgetState {
  return { ...stateFor(sessionId) };
}

export type BudgetCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * THE enforcement call. Increments the tool-call counter and rejects if any
 * limit is already breached — including the wall-clock/step/token/cost
 * limits that this call itself cannot have caused (a tool calling this at
 * the top of `execute()` is checking work already done by prior steps in
 * the same turn, not itself).
 */
export function recordToolCallStart(
  sessionId: string,
  limits: RequestBudgetLimits = DEFAULT_REQUEST_BUDGET,
  now: () => number = Date.now,
): BudgetCheckResult {
  const s = stateFor(sessionId, now);
  const elapsedMs = now() - s.startedAtMs;

  if (s.toolCalls >= limits.maxToolCalls) {
    return { ok: false, reason: `tool-call limit reached (${limits.maxToolCalls})` };
  }
  if (s.modelSteps >= limits.maxModelSteps) {
    return { ok: false, reason: `model-step limit reached (${limits.maxModelSteps})` };
  }
  if (elapsedMs >= limits.maxWallClockMs) {
    return { ok: false, reason: `wall-clock budget exceeded (${limits.maxWallClockMs}ms)` };
  }
  if (s.inputTokens + s.outputTokens >= limits.maxTokensPerTurn) {
    return { ok: false, reason: `token budget exceeded (${limits.maxTokensPerTurn})` };
  }
  if (s.estimatedCostUsd >= limits.maxEstimatedCostUsd) {
    return { ok: false, reason: `estimated cost budget exceeded ($${limits.maxEstimatedCostUsd})` };
  }

  s.toolCalls += 1;
  store.set(sessionId, s);
  return { ok: true };
}
