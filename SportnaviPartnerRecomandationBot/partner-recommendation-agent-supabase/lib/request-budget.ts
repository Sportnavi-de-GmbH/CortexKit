/**
 * lib/request-budget.ts
 *
 * Execution budget + render-context accounting (R13 §2–§3).
 *
 * eve has no `stopWhen`/`maxSteps` primitive and its hooks are observe-only
 * (cannot block a tool call or abort a turn), so this module is the actual
 * enforcement point: tools call `recordToolCallStart` synchronously at the
 * top of `execute()` and degrade to their honest structured-status shapes
 * when it says no. Bookkeeping (model-step counts, token usage) is fed in
 * from `agent/hooks/budget.ts`, which observes `step.completed` events.
 *
 * TWO STATE LIFETIMES (R13 §3.2, implements plans/R03):
 *  - PER-TURN: tool calls, model steps, usage, wall clock, searches admitted.
 *    Reset on every `message.received` AND at `turn.completed`/`turn.failed`.
 *  - PER-CONVERSATION: rendered-context tokens, reserved tokens, known
 *    partner names (grounding), the search ledger, rendered-partner ids.
 *    Survive turn resets; reconciled on `compaction.completed` (eve deletes
 *    tool-role messages when it compacts, so the rendered counter resets and
 *    the epoch bumps); dropped only when the session ends/fails.
 *
 * THE COMPACTION INVARIANT (R13 §3.1): eve compacts when projected INPUT
 * (system prompt + history + tool results) exceeds `window × 0.9`, checked
 * before every model call INSIDE the tool loop — and compaction DELETES tool
 * results. A render ceiling that ignores the prompt admits exactly what
 * compaction then destroys (the 2026-08-20 incident). The ceiling here is
 * therefore derived from the compaction threshold, minus the prompt, a prose
 * allowance and a safety margin — asserted at module load.
 */

import { createTtlCache } from "./cache";
import { DEFAULT_CONFIG } from "../agent/config/partner-injection.config";
import { getModelContextWindowTokens } from "./model-limits";

export interface RequestBudgetLimits {
  /** Tool INVOCATIONS per turn (1 batched search + follow-up detail calls). */
  maxToolCalls: number;
  /** Normal path is exactly 2 model steps for a search, 1 otherwise (CLAUDE.md §4.1). */
  maxModelSteps: number;
  /** Hard outer ceiling on a turn's wall clock. */
  maxWallClockMs: number;
  /** Reported usage ceiling per turn. */
  maxTokensPerTurn: number;
  /** Computed from raw usage x list price below — NOT LangSmith's cost figure,
   *  which CLAUDE.md §9 documents as ~8x wrong (double-count + ignored cache discount). */
  maxEstimatedCostUsd: number;
  /**
   * Ceiling on tool-result text the CONVERSATION may hold, in tokens.
   * See {@link renderCeilingTokens} — derived from the deployed model's
   * window AND eve's compaction threshold, never guessed.
   */
  maxRenderedContextTokens: number;
}

/** Rendered profile text is ~4 chars/token (measured, CLAUDE.md §7). */
const CHARS_PER_TOKEN = 4;

/** The stable system prompt (~18 KB of markdown ≈ 11k tokens, CLAUDE.md §4.1). */
const SYSTEM_PROMPT_TOKENS = 11_000;

/** Held back for the model's own reply. */
const OUTPUT_RESERVE_TOKENS = 8_000;

/** Allowance for accumulated conversation PROSE (user + assistant messages,
 *  framework overhead) across a long conversation. Prose is tiny per turn
 *  (~200–500 tokens) but it shares the compaction budget with tool results. */
const PROSE_ALLOWANCE_TOKENS = 16_000;

/** Slack for schema growth, header-estimate error, eve framework messages. */
const SAFETY_MARGIN_TOKENS = 8_000;

/** eve compacts when projected input exceeds window × this fraction
 *  (verified against eve's harness defaults — plans/R05, R13 §0.3). */
const COMPACTION_THRESHOLD_FRACTION = 0.9;

/** Measured Tier-2 cost per shown partner: 419 tokens of llm_profile + ~30
 *  of header/separator/disclosure share (R13 §4.5 — kills the undercount). */
export const TOKENS_PER_PARTNER_TIER2 = 450;

/** Hard cap on concurrently executing search pipelines (owner decision 4). */
export const MAX_CONCURRENT_SEARCHES = 3;

/** Hard cap on searches ADMITTED per turn, across all batch calls. */
export const MAX_SEARCHES_PER_TURN = 3;

/** A search worth running renders at least ~12 full profiles + overhead.
 *  Below this allotment a search defers whole rather than starving (R13 §2). */
export const MIN_SEARCH_ALLOTMENT_TOKENS = 6_000;

/** One search may never eat its siblings' floor (~100 profiles + overhead). */
export const MAX_SEARCH_ALLOTMENT_TOKENS = 45_000;

/**
 * How many tokens of tool-result text the conversation can afford, given the
 * model actually deployed. Two bounds, the tighter governs:
 *  - the COMPACTION bound: rendered + prompt + prose + margin must stay under
 *    eve's mid-loop compaction trigger, or a turn's own tool results get
 *    deleted before the model can answer from them (the incident);
 *  - the HARD bound: rendered + prompt + prose + output reserve must fit the
 *    window, or Azure rejects with `context_length_exceeded`.
 * On 128k this yields ≈80k; larger windows admit proportionally more.
 */
export function renderCeilingTokens(
  contextWindowTokens: number = getModelContextWindowTokens(),
): number {
  const compactionBound =
    Math.floor(contextWindowTokens * COMPACTION_THRESHOLD_FRACTION) -
    SYSTEM_PROMPT_TOKENS -
    PROSE_ALLOWANCE_TOKENS -
    SAFETY_MARGIN_TOKENS;
  const hardBound =
    contextWindowTokens - SYSTEM_PROMPT_TOKENS - OUTPUT_RESERVE_TOKENS - PROSE_ALLOWANCE_TOKENS;
  return Math.max(0, Math.min(compactionBound, hardBound));
}

/**
 * Kept for callers/tests that reason about the hard window bound alone.
 * NOTE: this bound is NOT sufficient on its own — see {@link renderCeilingTokens}.
 */
export function usableContextTokens(
  contextWindowTokens: number = getModelContextWindowTokens(),
): number {
  return Math.max(0, contextWindowTokens - SYSTEM_PROMPT_TOKENS - OUTPUT_RESERVE_TOKENS);
}

/**
 * R13 §3.1 — the asserted compaction invariant: a conversation that legally
 * fills the render ceiling must still be under eve's compaction trigger.
 * Throws on violation; also run at module load for the deployed window.
 */
export function assertBudgetInvariant(
  contextWindowTokens: number = getModelContextWindowTokens(),
): void {
  const ceiling = renderCeilingTokens(contextWindowTokens);
  const compactionTrigger = Math.floor(contextWindowTokens * COMPACTION_THRESHOLD_FRACTION);
  const projectedInput = ceiling + SYSTEM_PROMPT_TOKENS + PROSE_ALLOWANCE_TOKENS;
  if (projectedInput + SAFETY_MARGIN_TOKENS > compactionTrigger) {
    throw new Error(
      `request-budget invariant violated for window ${contextWindowTokens}: ` +
        `ceiling ${ceiling} + prompt ${SYSTEM_PROMPT_TOKENS} + prose ${PROSE_ALLOWANCE_TOKENS} ` +
        `+ margin ${SAFETY_MARGIN_TOKENS} exceeds compaction trigger ${compactionTrigger}`,
    );
  }
  if (ceiling <= 0) {
    throw new Error(
      `request-budget invariant violated: render ceiling is ${ceiling} for window ${contextWindowTokens}`,
    );
  }
}
assertBudgetInvariant();

/** Expected render size of one `find_partners` search at `n` shown profiles. */
export function expectedSearchTokens(
  finalRecommendations: number = DEFAULT_CONFIG.finalRecommendations,
): number {
  return finalRecommendations * TOKENS_PER_PARTNER_TIER2;
}

export const DEFAULT_REQUEST_BUDGET: RequestBudgetLimits = {
  maxToolCalls: 3,
  maxModelSteps: 4,
  maxWallClockMs: 20_000,
  maxTokensPerTurn: 80_000,
  maxEstimatedCostUsd: 0.15,
  maxRenderedContextTokens: renderCeilingTokens(),
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

/** One executed search, remembered for the conversation (R13 §5 ledger). */
export interface SearchLedgerEntry {
  city: string;
  intentText: string;
  tags: string[];
  foundCount: number;
  shownCount: number;
  /** Ids + names of SHOWN partners only — grounding roster material. */
  shownPartners: { id: number; name: string }[];
  /** Compaction epoch the render belongs to; pre-epoch renders are gone from
   *  model context and must be re-fetched before their details are cited. */
  epoch: number;
}

export interface BudgetState {
  // ── per-turn ──────────────────────────────────────────────────────────────
  toolCalls: number;
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  startedAtMs: number;
  /** Searches ADMITTED this turn, across all batch calls (cap: MAX_SEARCHES_PER_TURN). */
  searchesAdmittedThisTurn: number;
  // ── per-conversation ─────────────────────────────────────────────────────
  /** Shortlist names across the whole conversation — the grounding tripwire's
   *  reference set. Per-conversation so a follow-up naming a turn-1 partner
   *  never false-positives (R13 §5). */
  knownPartnerNames: string[];
  /**
   * Tool-result text currently live in the conversation's context, in tokens.
   * Updated by the tool itself, synchronously, the moment the text exists —
   * REPORTED usage (`inputTokens`) only arrives after the oversized request
   * has already been sent. Reset when compaction deletes the tool results.
   */
  renderedContextTokens: number;
  /** Tokens RESERVED by an in-flight batch before its renders commit — the
   *  synchronous reservation that closes the TOCTOU race (R13 §2). */
  reservedContextTokens: number;
  /** Bumped on every compaction.completed; renders from earlier epochs are
   *  no longer in model context. */
  epoch: number;
  /** Partner ids rendered in full during the CURRENT epoch — cross-search
   *  and cross-turn dedup renders these as stubs instead (R13 §5). */
  renderedPartnerIds: Set<number>;
  /** One entry per executed search — continuity ledger (R13 §5). */
  searchLedger: SearchLedgerEntry[];
}

function emptyState(now: number): BudgetState {
  return {
    toolCalls: 0,
    modelSteps: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    startedAtMs: now,
    searchesAdmittedThisTurn: 0,
    knownPartnerNames: [],
    renderedContextTokens: 0,
    reservedContextTokens: 0,
    epoch: 0,
    renderedPartnerIds: new Set(),
    searchLedger: [],
  };
}

/** 6 hours — conversation-scoped state must outlive slow conversations; the
 *  TTL is purely a leak backstop for sessions that never end cleanly. */
const BUDGET_TTL_SEC = 21_600;

const store = createTtlCache<BudgetState>(BUDGET_TTL_SEC, () => Date.now(), 1000);

function stateFor(sessionId: string, now: () => number = Date.now): BudgetState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const fresh = emptyState(now());
  store.set(sessionId, fresh);
  return fresh;
}

/**
 * Call on the turn's `message.received` (and on turn completion/failure) —
 * starts a fresh PER-TURN window while conversation-scoped accounting
 * survives (R13 §3.2 / plans/R03).
 */
export function resetBudget(sessionId: string, now: () => number = Date.now): void {
  const s = stateFor(sessionId, now);
  s.toolCalls = 0;
  s.modelSteps = 0;
  s.inputTokens = 0;
  s.outputTokens = 0;
  s.estimatedCostUsd = 0;
  s.startedAtMs = now();
  s.searchesAdmittedThisTurn = 0;
  // Reserved tokens must not leak across turns: an in-flight batch that never
  // committed (crash, cancel) would otherwise shrink every later turn.
  s.reservedContextTokens = 0;
  store.set(sessionId, s);
}

/** Call on `session.failed` (or teardown) — drops EVERYTHING, including
 *  conversation-scoped accounting. */
export function clearBudget(sessionId: string): void {
  store.set(sessionId, emptyState(Date.now()));
}

/**
 * Call on eve's `compaction.completed`: the tool-role messages are gone from
 * model context, so the rendered counter resets, the epoch bumps, and every
 * previously rendered partner must be re-fetched before it renders as a stub
 * again (R13 §5 / plans/R05).
 */
export function onCompactionCompleted(sessionId: string): void {
  const s = stateFor(sessionId);
  s.epoch += 1;
  s.renderedContextTokens = 0;
  s.renderedPartnerIds = new Set();
  store.set(sessionId, s);
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

/**
 * Record how much tool-result TEXT a tool just put into the conversation.
 * Callers pass the length of the EXACT string returned to the model (headers,
 * separators and disclosure included — R13 fixes the old profile-only
 * undercount), on BOTH the fresh and the cache-hit path.
 */
export function recordRenderedContext(sessionId: string, chars: number): void {
  const s = stateFor(sessionId);
  s.renderedContextTokens += Math.ceil(chars / CHARS_PER_TOKEN);
  store.set(sessionId, s);
}

/** Record shortlist names so the grounding tripwire can check replies. */
export function recordKnownNames(sessionId: string, names: string[]): void {
  const s = stateFor(sessionId);
  s.knownPartnerNames = [...s.knownPartnerNames, ...names];
  store.set(sessionId, s);
}

/** Append one executed search to the conversation ledger (R13 §5). */
export function recordSearchLedger(
  sessionId: string,
  entry: Omit<SearchLedgerEntry, "epoch">,
): void {
  const s = stateFor(sessionId);
  s.searchLedger.push({ ...entry, epoch: s.epoch });
  for (const p of entry.shownPartners) s.renderedPartnerIds.add(p.id);
  store.set(sessionId, s);
}

/** Has this partner already been rendered IN FULL during the current epoch?
 *  (If yes, later occurrences render as stubs — R13 §2/§5.) */
export function wasPartnerRendered(sessionId: string, partnerId: number): boolean {
  return stateFor(sessionId).renderedPartnerIds.has(partnerId);
}

export function getBudgetSnapshot(sessionId: string): BudgetState {
  const s = stateFor(sessionId);
  return {
    ...s,
    knownPartnerNames: [...s.knownPartnerNames],
    renderedPartnerIds: new Set(s.renderedPartnerIds),
    searchLedger: s.searchLedger.map((e) => ({ ...e, shownPartners: [...e.shownPartners] })),
  };
}

// ── Reservation ledger (R13 §2 — closes the TOCTOU race) ───────────────────

/** Synchronously reserve render budget BEFORE any await. Pair with
 *  `releaseRenderReservation` in a finally block. */
export function reserveRenderTokens(sessionId: string, tokens: number): void {
  const s = stateFor(sessionId);
  s.reservedContextTokens += Math.max(0, tokens);
  store.set(sessionId, s);
}

/** Release (part of) a reservation — after committing the actual render via
 *  `recordRenderedContext`, release the FULL original reservation. */
export function releaseRenderTokens(sessionId: string, tokens: number): void {
  const s = stateFor(sessionId);
  s.reservedContextTokens = Math.max(0, s.reservedContextTokens - Math.max(0, tokens));
  store.set(sessionId, s);
}

/** Render budget still available to the conversation right now. */
export function remainingRenderBudget(
  sessionId: string,
  limits: RequestBudgetLimits = DEFAULT_REQUEST_BUDGET,
): number {
  const s = stateFor(sessionId);
  return Math.max(
    0,
    limits.maxRenderedContextTokens - s.renderedContextTokens - s.reservedContextTokens,
  );
}

// ── Batch admission (R13 §2/§3.3) ───────────────────────────────────────────

export interface SearchAdmission {
  /** How many of the requested searches run now (0..MAX_SEARCHES_PER_TURN). */
  admitted: number;
  /** Render allotment per admitted search, in tokens. */
  allotmentTokens: number;
  /** Max full Tier-2 profiles the allotment affords per search. */
  maxShownPerSearch: number;
  /** Why the non-admitted remainder was cut: turn concurrency cap vs budget. */
  deferredReason: "concurrency" | "budget" | null;
}

/**
 * ONE atomic admission decision for a batch of requested searches. Runs
 * synchronously (no await between read and reserve) — this is what makes
 * four parallel projections against a stale counter impossible. The caller
 * MUST later `releaseRenderTokens(admitted × allotmentTokens)` (after
 * committing actuals) — including on failure paths.
 */
export function admitSearches(
  sessionId: string,
  requestedCount: number,
  limits: RequestBudgetLimits = DEFAULT_REQUEST_BUDGET,
): SearchAdmission {
  const s = stateFor(sessionId);
  const remaining = Math.max(
    0,
    limits.maxRenderedContextTokens - s.renderedContextTokens - s.reservedContextTokens,
  );
  const turnAllowance = Math.max(0, MAX_SEARCHES_PER_TURN - s.searchesAdmittedThisTurn);
  const budgetAllowance = Math.floor(remaining / MIN_SEARCH_ALLOTMENT_TOKENS);
  const admitted = Math.max(
    0,
    Math.min(MAX_CONCURRENT_SEARCHES, turnAllowance, requestedCount, budgetAllowance),
  );

  let deferredReason: SearchAdmission["deferredReason"] = null;
  if (admitted < requestedCount) {
    const concurrencyCap = Math.min(MAX_CONCURRENT_SEARCHES, turnAllowance);
    // Whichever cap actually bound the admission names the reason.
    deferredReason = budgetAllowance < concurrencyCap ? "budget" : "concurrency";
  }

  if (admitted === 0) {
    return { admitted: 0, allotmentTokens: 0, maxShownPerSearch: 0, deferredReason };
  }

  const allotmentTokens = Math.min(
    MAX_SEARCH_ALLOTMENT_TOKENS,
    Math.max(MIN_SEARCH_ALLOTMENT_TOKENS, Math.floor(remaining / admitted)),
  );
  const maxShownPerSearch = Math.max(1, Math.floor(allotmentTokens / TOKENS_PER_PARTNER_TIER2));

  // Atomic: reserve + count in the same synchronous frame as the reads above.
  s.reservedContextTokens += admitted * allotmentTokens;
  s.searchesAdmittedThisTurn += admitted;
  store.set(sessionId, s);

  return { admitted, allotmentTokens, maxShownPerSearch, deferredReason };
}

export type BudgetRejectionCode =
  | "tool_calls"
  | "model_steps"
  | "wall_clock"
  | "tokens"
  | "cost"
  /** The next result would not FIT in the model's context window. Distinct
   *  because it deserves a different reaction from the model: defer and
   *  continue next turn, never "try again with fewer details". */
  | "context_window";

export type BudgetCheckResult =
  | { ok: true }
  | { ok: false; reason: string; code: BudgetRejectionCode };

/**
 * THE per-turn enforcement call. Increments the tool-call counter and rejects
 * if any limit is already breached. Search ADMISSION (how many searches, how
 * big) is `admitSearches`; this call gates the tool invocation itself.
 */
export function recordToolCallStart(
  sessionId: string,
  limits: RequestBudgetLimits = DEFAULT_REQUEST_BUDGET,
  now: () => number = Date.now,
  /** Tokens this call is expected to add to the context. 0 for tools whose
   *  output is small and bounded (get_partner_details). */
  projectedContextTokens = 0,
): BudgetCheckResult {
  const s = stateFor(sessionId, now);
  const elapsedMs = now() - s.startedAtMs;

  if (s.toolCalls >= limits.maxToolCalls) {
    return {
      ok: false,
      code: "tool_calls",
      reason: `tool-call limit reached (${limits.maxToolCalls})`,
    };
  }
  if (s.modelSteps >= limits.maxModelSteps) {
    return {
      ok: false,
      code: "model_steps",
      reason: `model-step limit reached (${limits.maxModelSteps})`,
    };
  }
  if (elapsedMs >= limits.maxWallClockMs) {
    return {
      ok: false,
      code: "wall_clock",
      reason: `wall-clock budget exceeded (${limits.maxWallClockMs}ms)`,
    };
  }
  if (s.inputTokens + s.outputTokens >= limits.maxTokensPerTurn) {
    return {
      ok: false,
      code: "tokens",
      reason: `token budget exceeded (${limits.maxTokensPerTurn})`,
    };
  }
  if (s.estimatedCostUsd >= limits.maxEstimatedCostUsd) {
    return {
      ok: false,
      code: "cost",
      reason: `estimated cost budget exceeded ($${limits.maxEstimatedCostUsd})`,
    };
  }

  // PROJECTION against committed AND reserved render tokens — the reservation
  // ledger is what makes this correct under same-step parallel tool calls.
  if (projectedContextTokens > 0) {
    const projected =
      s.renderedContextTokens + s.reservedContextTokens + projectedContextTokens;
    if (projected > limits.maxRenderedContextTokens) {
      return {
        ok: false,
        code: "context_window",
        reason:
          `context projection ${projected} tokens exceeds the render ceiling ` +
          `(${limits.maxRenderedContextTokens}); ${s.renderedContextTokens} rendered, ` +
          `${s.reservedContextTokens} reserved`,
      };
    }
  }

  s.toolCalls += 1;
  store.set(sessionId, s);
  return { ok: true };
}
