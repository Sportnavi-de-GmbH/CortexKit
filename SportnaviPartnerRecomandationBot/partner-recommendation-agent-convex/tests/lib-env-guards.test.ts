import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "AZURE_AI_CHATBOT_OPENAI_ENDPOINT",
  "AZURE_AI_CHATBOT_API_KEY",
  "AZURE_AI_CHATBOT_DEPLOYMENT_NAME",
] as const;

describe("lib env guards", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("getConvex() throws naming the missing deployment URL", async () => {
    // getConvex() memoizes only after a SUCCESSFUL construction, and the
    // client is built lazily on the first backend call — so with the env
    // empty, the first call always re-validates.
    const { getConvex, resetConvexClient } = await import("../lib/convex");
    resetConvexClient();
    await expect(getConvex().cityCentroids()).rejects.toThrow(/CONVEX_URL/);
  });

  it("getConvex() accepts NEXT_PUBLIC_CONVEX_URL, the name `convex dev` writes", async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://example-deployment.convex.cloud";
    const { getConvex, resetConvexClient } = await import("../lib/convex");
    resetConvexClient();
    // Constructing the client must not throw; the call itself will fail on
    // the network, which is not what this test is about.
    await expect(getConvex().cityCentroids()).rejects.not.toThrow(/CONVEX_URL/);
    resetConvexClient();
  });

  it("getAzureChatModel() throws naming both missing env vars", async () => {
    const { getAzureChatModel } = await import("../lib/llm");
    expect(() => getAzureChatModel()).toThrow(
      /AZURE_AI_CHATBOT_OPENAI_ENDPOINT.*AZURE_AI_CHATBOT_API_KEY|AZURE_AI_CHATBOT_API_KEY.*AZURE_AI_CHATBOT_OPENAI_ENDPOINT/,
    );
  });

  it("getAzureChatModel() throws naming only the missing var when one is set", async () => {
    process.env.AZURE_AI_CHATBOT_OPENAI_ENDPOINT = "https://example.invalid";
    const { getAzureChatModel } = await import("../lib/llm");
    expect(() => getAzureChatModel()).toThrow(/AZURE_AI_CHATBOT_API_KEY/);
  });
});
