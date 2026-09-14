// One price table for both agents: lib/langfuse.ts MODEL_PRICES.
import { estimateCostUsd } from "../langfuse";
import type { Usage } from "./types";

export { estimateCostUsd };

/** undefined when there is nothing to price (no usage, or an unknown model — never invent a price). */
export function usageCost(model: string | undefined | null, usage: Usage | undefined): number | undefined {
  if (!model || !usage) return undefined;
  const usd = estimateCostUsd(model, usage.input, usage.output, usage.cached ?? 0);
  return usd > 0 ? Number(usd.toFixed(6)) : undefined;
}
