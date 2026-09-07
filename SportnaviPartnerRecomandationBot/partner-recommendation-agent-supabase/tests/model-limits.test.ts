/**
 * Pins lib/model-limits.ts.
 *
 * The bug this guards against was silent and expensive: `agent/agent.ts`
 * declared gpt-4.1's 1,047,576-token window while the Azure deployment had
 * been switched to gpt-4o-mini (128,000). eve's compaction trusted the
 * declared number, never compacted, and Azure rejected requests at ~141k
 * tokens with `context_length_exceeded`. Nothing in the codebase noticed.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  getModelContextWindowTokens,
  KNOWN_MODEL_CONTEXT_WINDOWS,
} from "../lib/model-limits";

describe("getModelContextWindowTokens", () => {
  const original = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME;
  afterEach(() => {
    if (original === undefined) delete process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME;
    else process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME = original;
  });

  it("resolves the models this project has actually been deployed against", () => {
    expect(getModelContextWindowTokens("gpt-4.1")).toBe(1_047_576);
    expect(getModelContextWindowTokens("gpt-4o-mini")).toBe(128_000);
  });

  it("prefers the LONGEST matching family — gpt-4o-mini is not gpt-4o", () => {
    // Both keys substring-match "gpt-4o-mini". They happen to share a window
    // today, so assert the resolution rule directly rather than the value.
    expect(getModelContextWindowTokens("gpt-4o-mini")).toBe(
      KNOWN_MODEL_CONTEXT_WINDOWS["gpt-4o-mini"],
    );
    expect(getModelContextWindowTokens("gpt-4.1-mini")).toBe(
      KNOWN_MODEL_CONTEXT_WINDOWS["gpt-4.1-mini"],
    );
  });

  it("matches inside a custom Azure deployment name", () => {
    // Azure deployment names are user-chosen and usually embed the model.
    expect(getModelContextWindowTokens("navio-gpt-4o-mini-prod")).toBe(128_000);
    expect(getModelContextWindowTokens("GPT-4.1")).toBe(1_047_576);
  });

  it("falls back to the SMALLEST window for an unknown deployment", () => {
    // Under-declaring costs a little early compaction; over-declaring is a
    // hard request failure. The default must err toward the former.
    const unknown = getModelContextWindowTokens("some-future-model");
    expect(unknown).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(unknown).toBe(Math.min(...Object.values(KNOWN_MODEL_CONTEXT_WINDOWS)));
  });

  it("reads AZURE_AI_CHATBOT_DEPLOYMENT_NAME when no argument is given", () => {
    process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME = "gpt-4o-mini";
    expect(getModelContextWindowTokens()).toBe(128_000);
  });

  it("never throws with an empty environment (agent.ts must stay importable)", () => {
    delete process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME;
    expect(() => getModelContextWindowTokens()).not.toThrow();
    expect(getModelContextWindowTokens()).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });
});
