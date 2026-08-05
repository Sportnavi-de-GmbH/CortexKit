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

  it("getSupabase() throws naming both missing env vars", async () => {
    // Fresh import per test would require resetModules; getSupabase caches
    // its client only after a successful construction, so calling it while
    // envs are empty always re-validates.
    const { getSupabase } = await import("../lib/supabase");
    expect(() => getSupabase()).toThrow(
      /MEMORY_SUPABASE_URL.*MEMORY_SUPABASE_SERVICE_ROLE_KEY|MEMORY_SUPABASE_SERVICE_ROLE_KEY.*MEMORY_SUPABASE_URL/,
    );
  });

  it("getSupabase() throws naming only the missing var when one is set", async () => {
    process.env.MEMORY_SUPABASE_URL = "https://example.supabase.co";
    const { getSupabase } = await import("../lib/supabase");
    expect(() => getSupabase()).toThrow(/MEMORY_SUPABASE_SERVICE_ROLE_KEY/);
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
