import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  faqRequestDraft,
  faqPromptDraft,
  faqStepDraft,
  faqCompletedDraft,
  faqFailureDraft,
  freshFaqTurn,
  readUsage,
  turnStateStore,
} from "../lib/monitoring/faq-mapper";
import { monitoringHandlers } from "../agent/hooks/monitoring";
import { createStore } from "../lib/monitoring/store";
import { systemPromptStore } from "../lib/langfuse";
import type { TraceDraft } from "../lib/monitoring/types";

const env = { agentVersion: "abc", environment: "test", model: "gpt-4.1", channel: "http" };
const ctx = { agent: { name: "kb-agent" }, channel: { kind: "http" }, session: { id: "sess-mon" } };
const ENV = {
  MONITORING_SUPABASE_URL: "https://x.supabase.co",
  MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k",
} as unknown as NodeJS.ProcessEnv;

describe("faq mapper", () => {
  it("request draft: running trace, session, request-received step", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_2", question: "Was ist Firmenfitness?", startedAt: 1000 };
    const d = faqRequestDraft(s, env, 1000);
    expect(d.session).toMatchObject({ id: "s1", agent: "faq" });
    expect(d.trace).toMatchObject({
      session_id: "s1", turn_id: "turn_2", turn_index: 2, status: "running", user_input: "Was ist Firmenfitness?", agent_version: "abc",
    });
    expect(d.steps[0]).toMatchObject({ step_key: "request-received", kind: "request", status: "ok", input: { message: "Was ist Firmenfitness?" } });
    expect(d.trace.metadata).toMatchObject({ env: "test", channel: "http" });
  });
  it("prompt draft: fingerprints the KB and attaches the prompt version", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1" };
    const prompt = "=== KNOWLEDGE BASE ===\nFAQ\n=== BEHAVIOR RULES ===\nx";
    const d = faqPromptDraft(s, prompt, env, 5);
    expect(d.prompt).toMatchObject({ agent: "faq", size_chars: prompt.length, sections: ["KNOWLEDGE BASE", "BEHAVIOR RULES"] });
    expect(d.prompt!.sha256).toHaveLength(64);
    expect(d.steps[0]).toMatchObject({ step_key: "load-knowledge-base", kind: "transform", status: "ok" });
    expect(d.steps[0]!.purpose).toContain(d.prompt!.sha256.slice(0, 12));
    expect(d.steps[0]!.metadata).toMatchObject({ prompt_sha256: d.prompt!.sha256 });
  });
  it("step draft: generate-answer with model, usage, duration and cost", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1", stepStartedAt: 1000, question: "q" };
    const d = faqStepDraft(
      s,
      { usage: { inputTokens: 17000, outputTokens: 200, inputTokenDetails: { cacheReadTokens: 16000 } }, finishReason: "stop" },
      env,
      3500,
    );
    expect(d.steps[0]).toMatchObject({
      step_key: "generate-answer", kind: "llm", model: "gpt-4.1", tokens_input: 17000, tokens_output: 200, tokens_cached: 16000, duration_ms: 2500,
    });
    expect(d.steps[0]!.cost_estimate_usd).toBeGreaterThan(0);
    expect(s.usage).toEqual({ input: 17000, output: 200, cached: 16000 });
    expect(s.steps).toBe(1);
  });
  it("completed draft: totals, first token, answer-delivered", () => {
    const s = {
      ...freshFaqTurn("s1"), turnId: "turn_1", startedAt: 1000, firstTokenAt: 1400, question: "q", reply: "Antwort", steps: 1,
      usage: { input: 100, output: 10, cached: 0 },
    };
    const d = faqCompletedDraft(s, env, 2000);
    expect(d.trace).toMatchObject({
      status: "completed", final_output: "Antwort", duration_ms: 1000, first_token_ms: 400, tokens_input: 100, tokens_output: 10, models: ["gpt-4.1"], step_count: 4,
    });
    expect(d.steps[0]).toMatchObject({ step_key: "answer-delivered", kind: "response", output: { answer: "Antwort" } });
  });
  it("failure draft: classified error step + errors row + failed status", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1", startedAt: 1000, question: "q" };
    const d = faqFailureDraft(s, "turn", { code: "turn_error", message: "429 too many requests" }, env, 1500);
    expect(d.trace.status).toBe("failed");
    expect(d.steps[0]).toMatchObject({ step_key: "failure", kind: "error", status: "error" });
    expect(d.errors[0]).toMatchObject({ level: "error", type: "upstream_unavailable", message: "429 too many requests" });
    expect(d.trace.error_count).toBe(1);
  });
  it("readUsage accepts the AI SDK and OpenAI spellings", () => {
    expect(readUsage({ promptTokens: 5, completionTokens: 2, promptTokensDetails: { cachedTokens: 1 } })).toEqual({ input: 5, output: 2, cached: 1 });
    expect(readUsage(undefined)).toEqual({ input: 0, output: 0, cached: 0 });
  });
});

describe("monitoring hook", () => {
  beforeEach(() => {
    systemPromptStore.delete(ctx.session.id);
    turnStateStore.delete(ctx.session.id);
  });
  const setup = () => {
    const calls: { p: TraceDraft }[] = [];
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args as unknown as { p: TraceDraft });
      return { data: "t", error: null };
    });
    const store = createStore({ client: { rpc }, env: ENV });
    let t = 1000;
    const handlers = monitoringHandlers({ store, now: () => (t += 100), env });
    return { calls, handlers };
  };
  it("writes a running row, then the KB + model step, then completion", async () => {
    const { calls, handlers } = setup();
    systemPromptStore.set(ctx.session.id, "=== KNOWLEDGE BASE ===\nFAQ");
    await handlers["message.received"]!({ data: { message: "Wie checke ich ein?", turnId: "turn_1" } }, ctx);
    await handlers["step.started"]!({ data: {} }, ctx);
    await handlers["step.completed"]!({ data: { usage: { inputTokens: 10, outputTokens: 2 } } }, ctx);
    await handlers["message.appended"]!({ data: { delta: "S" } }, ctx);
    await handlers["message.completed"]!({ data: { text: "Scanne den QR-Code" } }, ctx);
    await handlers["turn.completed"]!({ data: { turnId: "turn_1" } }, ctx);
    expect(calls.map((c) => c.p.steps.map((s) => s.step_key))).toEqual([
      ["request-received"],
      ["load-knowledge-base", "generate-answer"],
      ["answer-delivered"],
    ]);
    expect(calls[0]!.p.trace.status).toBe("running");
    expect(calls[1]!.p.prompt).toBeDefined();
    expect(calls[1]!.p.steps[1]).toMatchObject({ tokens_input: 10, duration_ms: 100 });
    expect(calls[2]!.p.trace).toMatchObject({ status: "completed", final_output: "Scanne den QR-Code", turn_id: "turn_1", first_token_ms: 300 });
    expect(turnStateStore.get(ctx.session.id)).toBeUndefined(); // released
  });
  it("survives a cold instance: state comes back from disk", async () => {
    const { calls, handlers } = setup();
    await handlers["message.received"]!({ data: { message: "hi", turnId: "turn_4" } }, ctx);
    const cold = setup(); // fresh in-memory map, same session
    await cold.handlers["message.completed"]!({ data: { text: "Antwort" } }, ctx);
    await cold.handlers["turn.completed"]!({ data: {} }, ctx);
    expect(calls).toHaveLength(1);
    expect(cold.calls[0]!.p.trace).toMatchObject({ turn_id: "turn_4", status: "completed", final_output: "Antwort" });
    expect(cold.calls[0]!.p.trace).not.toHaveProperty("user_input"); // the RPC keeps the running row's value
  });
  it("a failed turn writes the failure and marks the trace failed", async () => {
    const { calls, handlers } = setup();
    await handlers["message.received"]!({ data: { message: "hi", turnId: "turn_1" } }, ctx);
    await handlers["turn.failed"]!({ data: { code: "turn_error", message: "boom" } }, ctx);
    expect(calls.at(-1)!.p.trace.status).toBe("failed");
    expect(calls.at(-1)!.p.steps[0]!.step_key).toBe("failure");
  });
  it("never throws, even when the store client explodes", async () => {
    const store = createStore({
      client: { rpc: async () => { throw new Error("x"); } },
      env: ENV,
      log: () => {},
    });
    const handlers = monitoringHandlers({ store, env });
    await expect(handlers["message.received"]!({ data: { message: "hi" } }, ctx)).resolves.toBeUndefined();
    await expect(handlers["turn.completed"]!({ data: {} }, ctx)).resolves.toBeUndefined();
  });
  it("is inert without credentials", async () => {
    const handlers = monitoringHandlers({ store: createStore({ env: {} as NodeJS.ProcessEnv }), env });
    await handlers["message.received"]!({ data: { message: "hi", turnId: "turn_9" } }, ctx);
    expect(turnStateStore.get(ctx.session.id)).toBeUndefined();
  });
});
