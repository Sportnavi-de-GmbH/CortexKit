import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
  "MEMORY_SUPABASE_URL",
  "MEMORY_SUPABASE_SERVICE_ROLE_KEY",
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

  it("getSupabase() rejects (never throws synchronously) naming BOTH missing vars", async () => {
    // The client is built lazily inside each call, so with the env empty the
    // first call always re-validates — and it must surface as a rejection:
    // the gap-fill fan-out holds promises before awaiting them.
    const { getSupabase, resetSupabaseClient } = await import("../lib/supabase");
    resetSupabaseClient();
    const promise = getSupabase().cityCentroids();
    await expect(promise).rejects.toThrow(/MEMORY_SUPABASE_URL/);
    await expect(promise).rejects.toThrow(/MEMORY_SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("getSupabase() names only the missing var when the other is set", async () => {
    process.env.MEMORY_SUPABASE_URL = "https://example-project.supabase.co";
    const { getSupabase, resetSupabaseClient } = await import("../lib/supabase");
    resetSupabaseClient();
    const promise = getSupabase().cityCentroids();
    await expect(promise).rejects.toThrow(/MEMORY_SUPABASE_SERVICE_ROLE_KEY/);
    await expect(promise).rejects.not.toThrow(/MEMORY_SUPABASE_URL,/);
    resetSupabaseClient();
  });

  it("getSupabase() constructs a client once both vars are present", async () => {
    process.env.MEMORY_SUPABASE_URL = "https://example-project.supabase.co";
    process.env.MEMORY_SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { getSupabase, resetSupabaseClient } = await import("../lib/supabase");
    resetSupabaseClient();
    // Construction must not throw; the call itself fails on the network,
    // which is not what this test is about.
    await expect(getSupabase().cityCentroids()).rejects.not.toThrow(/MEMORY_SUPABASE/);
    resetSupabaseClient();
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
