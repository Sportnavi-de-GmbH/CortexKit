/**
 * Stage 2 — Reformulate the question into a descriptive retrieval query.
 * `originalUserQuery` is never altered; only `retrievalQuery` is embedded later.
 * Any model problem degrades to the original text with a warning.
 */
import { timeoutSignal } from "../../lib/reused/timeout";
import type { ReformulateOutput, StageContext, StageResult } from "../types";

export async function reformulate(input: { query: string }, ctx: StageContext): Promise<StageResult<ReformulateOutput>> {
  const config = {
    enableQueryReformulation: ctx.config.enableQueryReformulation,
    maxRetrievalQueryChars: ctx.config.maxRetrievalQueryChars,
  };
  const identity: ReformulateOutput = { originalUserQuery: input.query, retrievalQuery: input.query, reformulated: false };
  if (!ctx.config.enableQueryReformulation) return { output: identity, config };

  const warnings: string[] = [];
  try {
    const signal = AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.modelTimeoutMs)]);
    let text = (await ctx.deps.llm.reformulate(input.query, { maxChars: ctx.config.maxRetrievalQueryChars, signal })).trim();
    if (!text) {
      warnings.push("Reformulation returned an empty query; using the original question.");
      return { output: identity, config, warnings };
    }
    if (text.length > ctx.config.maxRetrievalQueryChars) {
      warnings.push(`Reformulated query truncated from ${text.length} to ${ctx.config.maxRetrievalQueryChars} chars.`);
      text = text.slice(0, ctx.config.maxRetrievalQueryChars);
    }
    return {
      output: { originalUserQuery: input.query, retrievalQuery: text, reformulated: true, model: ctx.deps.llm.modelName },
      config,
      counts: { originalChars: input.query.length, retrievalChars: text.length },
      warnings,
    };
  } catch (e) {
    warnings.push(`Reformulation failed (${(e as Error).message}); using the original question.`);
    return { output: identity, config, warnings };
  }
}
