/**
 * lib/model-limits.ts — the context window of the deployed chat model.
 *
 * WHY THIS EXISTS
 *
 * `agent/agent.ts` must tell eve how big the model's context window is, because
 * that number is what eve's compaction uses to decide when to summarize the
 * conversation instead of sending it whole. It used to be a hardcoded
 * `1_047_576` (gpt-4.1's window) with a comment explaining that the real Azure
 * deployment is resolved separately, at session start.
 *
 * That is exactly the shape of a bug that waits. The moment
 * `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` was changed from `gpt-4.1` to
 * `gpt-4o-mini` — a 1,047,576 -> 128,000 token drop — the declared number was
 * wrong by 8x and nothing said so. eve kept believing it had a megatoken of
 * room, never compacted, and Azure rejected the request:
 *
 *   This model's maximum context length is 128000 tokens. However, your
 *   messages resulted in 141416 tokens.
 *
 * Note what that error is NOT: it is not a rate limit. A rate limit is HTTP 429
 * ("exceeded rate limit"), a tokens-per-minute quota, and raising it fixes
 * nothing here. This is HTTP 400 `context_length_exceeded` — a hard per-request
 * ceiling that no quota change can lift.
 *
 * So the window is now DERIVED from the deployment name rather than asserted
 * next to it. Swapping the model updates the limit automatically, and an
 * unrecognized deployment falls back to the most conservative window in the
 * table rather than the most generous one — under-declaring makes eve compact
 * a little early, over-declaring produces the hard failure above.
 */

/**
 * Context windows in tokens, keyed by the model family in the Azure deployment
 * name. Matched case-insensitively as a SUBSTRING, because Azure deployment
 * names are user-chosen and usually embed the model (`gpt-4o-mini-prod`,
 * `navio-gpt-4.1`). Longest key wins, so `gpt-4o-mini` beats `gpt-4o`.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "o3": 200_000,
  "o4-mini": 200_000,
};

/** Used when the deployment name matches nothing above. Deliberately the
 *  smallest common window: compacting early is a performance cost, declaring
 *  too much is a hard request failure. */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Resolves the context window for `deploymentName`, defaulting to
 * `AZURE_AI_CHATBOT_DEPLOYMENT_NAME`.
 *
 * Never throws — `agent/agent.ts` must stay importable with an empty
 * environment (the smoke test imports it directly and CI has no secrets).
 */
export function getModelContextWindowTokens(
  deploymentName: string | undefined = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME,
): number {
  if (!deploymentName) return FALLBACK_CONTEXT_WINDOW_TOKENS;

  const needle = deploymentName.toLowerCase();
  let best: { key: string; tokens: number } | undefined;

  for (const [key, tokens] of Object.entries(CONTEXT_WINDOWS)) {
    if (!needle.includes(key)) continue;
    // Longest match wins: "gpt-4o-mini-prod" must resolve as gpt-4o-mini, and
    // both "gpt-4o" and "gpt-4o-mini" match it.
    if (best === undefined || key.length > best.key.length) best = { key, tokens };
  }

  return best?.tokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
}

/** Exposed for tests and diagnostics. */
export const KNOWN_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = CONTEXT_WINDOWS;
