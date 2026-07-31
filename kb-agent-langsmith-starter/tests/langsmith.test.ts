// The invariants that matter (guide Part B checkpoint + §14):
//  1. failures become LangSmith runs with the story-form shape (§9.4);
//  2. the hook NEVER throws — a thrown hook would itself fail the turn;
//  3. no API key = every surface is a silent no-op;
//  4. the span filter keeps AI spans + their ancestor chain, drops noise;
//  5. every LangSmith URL derives from the EU constant;
//  6. trace anchors + system prompts survive the instrumentation↔hook
//     module boundary (file-backed stores).
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { handlersFor, type LangSmithLike } from "../agent/hooks/langsmith.ts";
import {
  LANGSMITH_EU_API_URL,
  LANGSMITH_EU_OTEL_TRACES_URL,
  attachmentFor,
  dottedStampFromHr,
  dottedStampFromMs,
  failureMessage,
  failureRunPayload,
  humanSpanName,
  langsmithEnabled,
  otelRunId,
  projectName,
  recordIo,
  shouldExportSpan,
  SpanFilterState,
  systemPromptStore,
  traceAnchors,
  TurnJournal,
} from "../lib/langsmith.ts";

const ctx = {
  agent: { name: "test-agent" },
  channel: { kind: "http" },
  session: { id: "sess_test_1" },
};

/** Next's types make NODE_ENV a required ProcessEnv key, so a plain cast
 *  fails; route through unknown for the partial-env test fixtures. */
function env(o: Record<string, string> = {}): NodeJS.ProcessEnv {
  return o as unknown as NodeJS.ProcessEnv;
}

function fakeClient() {
  const calls: Record<string, unknown>[] = [];
  const client: LangSmithLike = {
    async createRun(payload) {
      calls.push(payload);
    },
  };
  return { client, calls };
}

afterAll(() => {
  rmSync(".data/anchors", { recursive: true, force: true });
  rmSync(".data/system-prompts", { recursive: true, force: true });
});

describe("EU region (Step A1)", () => {
  it("all LangSmith URLs derive from the EU regional base", () => {
    expect(LANGSMITH_EU_API_URL).toBe("https://eu.api.smith.langchain.com");
    expect(LANGSMITH_EU_OTEL_TRACES_URL).toBe(
      "https://eu.api.smith.langchain.com/otel/v1/traces",
    );
    // The US host must never appear.
    expect(LANGSMITH_EU_API_URL).not.toMatch(/\/\/api\.smith\.langchain\.com/);
  });

  it("env helpers: enabled/project/recordIo defaults", () => {
    expect(langsmithEnabled(env())).toBe(false);
    expect(langsmithEnabled(env({ LANGSMITH_API_KEY: " " }))).toBe(false);
    expect(langsmithEnabled(env({ LANGSMITH_API_KEY: "k" }))).toBe(true);
    expect(projectName(env())).toBe("kb-agent-langsmith-starter");
    expect(projectName(env({ LANGSMITH_PROJECT: "x" }))).toBe("x");
    expect(recordIo(env())).toBe(false);
    expect(recordIo(env({ LANGSMITH_RECORD_IO: "true" }))).toBe(true);
  });
});

describe("span filter (Step A3)", () => {
  it("shouldExportSpan keeps AI spans, drops workflow noise", () => {
    // Real span names observed live on eve 0.25.3 / ai 7.0.34.
    expect(shouldExportSpan("ai.eve.turn", ["eve.session.id"])).toBe(true);
    expect(shouldExportSpan("chat gpt-4.1", ["gen_ai.request.model"])).toBe(true);
    expect(shouldExportSpan("invoke_agent gpt-4.1", ["gen_ai.operation.name"])).toBe(true);
    expect(shouldExportSpan("step 1", ["ai.operationId"])).toBe(true);
    expect(
      shouldExportSpan("workflow.run workflow//eve//workflowEntry", ["workflow.id"]),
    ).toBe(false);
    expect(shouldExportSpan("fetch POST http://127.0.0.1:52965/x", ["http.method"])).toBe(false);
    expect(shouldExportSpan("workflow.stream.flush", [])).toBe(false);
  });

  it("SpanFilterState exports AI spans plus their ancestor chain, drops siblings", () => {
    const state = new SpanFilterState();
    // workflow root → workflow.execute → ai.eve.turn → chat, with a noisy
    // fetch sibling. Children end before parents.
    state.onStart("root", undefined);
    state.onStart("exec", "root");
    state.onStart("fetch1", "exec"); // noise sibling
    state.onStart("turn", "exec");
    state.onStart("chat", "turn");
    expect(state.onEnd("fetch1", "exec", false)).toBe(false); // noise dropped
    expect(state.onEnd("chat", "turn", true)).toBe(true); // AI span kept
    expect(state.onEnd("turn", "exec", true)).toBe(true); // AI turn kept
    expect(state.onEnd("exec", "root", false)).toBe(true); // ancestor kept
    expect(state.onEnd("root", undefined, false)).toBe(true); // root kept
    // A later unrelated workflow tree is still dropped entirely.
    state.onStart("root2", undefined);
    state.onStart("fetch2", "root2");
    expect(state.onEnd("fetch2", "root2", false)).toBe(false);
    expect(state.onEnd("root2", undefined, false)).toBe(false);
  });
});

describe("failure capture (Part B)", () => {
  it("a failed tool result becomes a story-form failure run", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj");
    await handlers["action.result"](
      {
        data: {
          result: { isError: true, toolName: "calculate_division", output: "division by zero" },
        },
      },
      ctx,
    );
    expect(calls).toHaveLength(1);
    const run = calls[0] as Record<string, any>;
    // §9.4: human name in the run list, raw error preserved for developers.
    expect(run.name).toBe("Calculator Tool Failed: Cannot divide by zero");
    expect(run.run_type).toBe("chain");
    expect(run.error).toBe("division by zero");
    expect(run.project_name).toBe("proj");
    const m = run.extra.metadata;
    expect(m["eve.session.id"]).toBe("sess_test_1");
    expect(m["failure.subject"]).toBe("calculate_division");
    expect(m.error_type).toBe("invalid_input");
    expect(m.user_friendly_message).toBe(
      "The calculation could not be completed because the second number was zero.",
    );
    expect(m.failed_step).toBe("Calling Calculator Tool");
    expect(m.user_goal).toBe("Divide two numbers");
    expect(m.recommended_action).toBe("Ask the user for a non-zero divisor and retry.");
    expect(m.thread_id).toBe("sess_test_1");
  });

  it("an unknown tool failure still gets a human name and safe fallbacks", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj");
    await handlers["action.result"](
      { data: { result: { isError: true, toolName: "mystery", output: "boom" } } },
      ctx,
    );
    const run = calls[0] as Record<string, any>;
    expect(run.name).toBe("mystery Tool Failed: boom");
    expect(run.extra.metadata.error_type).toBe("unexpected");
    expect(run.extra.metadata.user_friendly_message).toContain("boom");
  });

  it("a successful tool result creates no run", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj");
    await handlers["action.result"](
      { data: { result: { isError: false, toolName: "divide", output: { result: 5 } } } },
      ctx,
    );
    expect(calls).toHaveLength(0);
  });

  it("turn.failed carries code and message into the error field", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj");
    await handlers["turn.failed"](
      { data: { code: "model_error", message: "upstream 500" } },
      ctx,
    );
    const run = calls[0] as Record<string, any>;
    expect(run.name).toBe("Agent Turn (model_error) Failed: upstream 500");
    expect(run.error).toBe("[model_error] upstream 500");
  });

  it("a throwing client never escapes the hook (IRON RULE)", async () => {
    const boom: LangSmithLike = {
      async createRun() {
        throw new Error("network down");
      },
    };
    const handlers = handlersFor(boom, "proj");
    // Would fail the turn (or escalate turn.failed → session.failed) if it threw.
    await expect(
      (async () => {
        await handlers["turn.failed"]({ data: { code: "x" } }, ctx);
        await handlers["session.failed"]({ data: { code: "y" } }, ctx);
        await handlers["action.result"]({ data: { result: { isError: true } } }, ctx);
      })(),
    ).resolves.toBeUndefined();
  });

  it("no client (no API key) is a silent no-op", async () => {
    const handlers = handlersFor(undefined, "proj");
    await expect(
      handlers["turn.failed"]({ data: { code: "x" } }, ctx),
    ).resolves.toBeUndefined();
  });

  it("failureMessage handles string, object, and garbage payloads", () => {
    expect(failureMessage("raw text", "fb")).toEqual({ message: "raw text" });
    expect(failureMessage({ code: "c", message: "m" }, "fb")).toEqual({
      message: "m",
      code: "c",
    });
    expect(failureMessage(undefined, "fb")).toEqual({ message: "fb", code: undefined });
    expect(failureMessage(42, "fb")).toEqual({ message: "fb", code: undefined });
  });

  it("failureRunPayload stamps metadata and timestamps", () => {
    const run = failureRunPayload({
      kind: "session",
      subject: "session_error",
      data: { message: "boom" },
      sessionId: "s",
      agentName: "a",
      project: "p",
      now: 123,
    });
    expect(run.start_time).toBe(123);
    expect(run.end_time).toBe(123);
    expect(run.extra.metadata["app.channel.kind"]).toBe("unknown");
    expect(run.extra.metadata["failure.kind"]).toBe("session");
  });
});

describe("turn summary (Step B3)", () => {
  it("a completed turn produces a Customer Request summary run with IO, timing, and usage", async () => {
    const { client, calls } = fakeClient();
    let t = 1000;
    const handlers = handlersFor(client, "proj", new TurnJournal(), {
      recordContent: true,
      now: () => (t += 500),
    });
    await handlers["message.received"]({ data: { message: "Use the tool to divide 10 by 2" } }, ctx);
    await handlers["step.completed"](
      { data: { usage: { inputTokens: 2500, outputTokens: 30 } } },
      ctx,
    );
    await handlers["action.result"](
      { data: { result: { isError: false, toolName: "calculate_division", output: { result: 5 } } } },
      ctx,
    );
    await handlers["step.completed"](
      { data: { usage: { inputTokens: 2500, outputTokens: 10 } } },
      ctx,
    );
    await handlers["message.completed"]({ data: { text: "5", finishReason: "stop" } }, ctx);
    await handlers["turn.completed"]({ data: {} }, ctx);

    expect(calls).toHaveLength(1);
    const run = calls[0] as Record<string, any>;
    expect(run.name).toBe('Customer Request: "Use the tool to divide 10 by 2"');
    expect(run.inputs).toEqual({ user_message: "Use the tool to divide 10 by 2" });
    expect(run.outputs).toEqual({ agent_reply: "5", outcome: "answered" });
    expect(run.error).toBeUndefined();
    expect(run.end_time).toBeGreaterThan(run.start_time);
    const m = run.extra.metadata;
    expect(m["app.outcome"]).toBe("answered");
    expect(m["app.model_steps"]).toBe("2");
    expect(m["app.tools_used"]).toBe("calculate_division");
    expect(m["app.tool_errors"]).toBe("0");
    expect(m["app.tokens.input"]).toBe("5000");
    expect(m["app.tokens.output"]).toBe("40");
    expect(m["app.tokens.total"]).toBe("5040");
    expect(m.thread_id).toBe("sess_test_1");
  });

  it("content capture off redacts the summary run's IO but keeps the numbers", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj", new TurnJournal(), {
      recordContent: false,
      now: () => 1,
    });
    await handlers["message.received"]({ data: { message: "secret question" } }, ctx);
    await handlers["step.completed"]({ data: { usage: { inputTokens: 10, outputTokens: 2 } } }, ctx);
    await handlers["turn.completed"]({ data: {} }, ctx);
    const run = calls[0] as Record<string, any>;
    expect(JSON.stringify(run.inputs)).not.toContain("secret");
    expect(run.name).not.toContain("secret");
    expect(run.extra.metadata["app.tokens.input"]).toBe("10");
  });

  it("a failed turn produces both the failure run and a failed summary run", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj", new TurnJournal(), {
      recordContent: true,
      now: () => 1,
    });
    await handlers["message.received"]({ data: { message: "divide 1 by 0" } }, ctx);
    await handlers["turn.failed"]({ data: { code: "boom", message: "it broke" } }, ctx);
    expect(calls).toHaveLength(2);
    const summary = calls[1] as Record<string, any>;
    expect(summary.extra.metadata["app.outcome"]).toBe("failed");
    expect(String(summary.error)).toContain("failure run");
  });

  it("a turn with no journaled state produces no summary run", async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client, "proj", new TurnJournal(), { now: () => 1 });
    await handlers["turn.completed"]({ data: {} }, ctx);
    expect(calls).toHaveLength(0);
  });
});

describe("trace anchors (Part C)", () => {
  it("otelRunId derives LangSmith's deterministic span→run id mapping", () => {
    expect(otelRunId("a1b2c3d4e5f60718")).toBe("00000000-0000-0000-a1b2-c3d4e5f60718");
  });

  it("dotted stamps have the documented shape", () => {
    // 2026-07-27T10:00:00.123456 UTC
    expect(dottedStampFromHr(1785146400, 123_456_000)).toBe("20260727T100000123456Z");
    expect(dottedStampFromMs(1785146400123)).toBe("20260727T100000123000Z");
  });

  it("attachmentFor nests a run under the anchored root; no anchor = standalone", () => {
    const anchor = {
      rootRunId: "00000000-0000-0000-a1b2-c3d4e5f60718",
      rootDotted: "20260727T100000123456Z00000000-0000-0000-a1b2-c3d4e5f60718",
      rootStartMs: 1785146400123,
    };
    const att = attachmentFor(anchor, "run-1", 1785146401000)!;
    expect(att.trace_id).toBe(anchor.rootRunId);
    expect(att.parent_run_id).toBe(anchor.rootRunId);
    expect(att.dotted_order).toBe(`${anchor.rootDotted}.20260727T100001000000Zrun-1`);
    expect(attachmentFor(undefined, "run-1", 0)).toBeUndefined();
  });

  it("traceAnchors round-trips through the file store (cross-bundle bridge)", () => {
    const anchor = { rootRunId: "r", rootDotted: "d", rootStartMs: 5 };
    traceAnchors.set("sess_anchor_test", anchor);
    expect(traceAnchors.get("sess_anchor_test")).toEqual(anchor);
    traceAnchors.delete("sess_anchor_test");
    expect(traceAnchors.get("sess_anchor_test")).toBeUndefined();
  });

  it("the summary run becomes the trace root when an anchor exists", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "hi" }, 100);
    const run = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "a",
      project: "p",
      recordContent: true,
      now: 200,
      anchor: { rootRunId: "root-id", rootDotted: "STAMPZroot-id", rootStartMs: 50 },
    })!;
    expect(run.id).toBe("root-id");
    expect(run.trace_id).toBe("root-id");
    expect(run.dotted_order).toBe("STAMPZroot-id");
    expect(run.start_time).toBe(50); // must match the dotted_order stamp
  });
});

describe("system prompt capture (Part D)", () => {
  it("round-trips through the file store and lands on the root run inputs", () => {
    systemPromptStore.set("sess_sp_test", "You are a helpful KB agent.");
    expect(systemPromptStore.get("sess_sp_test")).toBe("You are a helpful KB agent.");

    const journal = new TurnJournal();
    journal.record("s2", "message.received", { message: "hi" }, 100);
    const run = journal.finalize({
      sessionId: "s2",
      outcome: "answered",
      agentName: "a",
      project: "p",
      recordContent: true,
      now: 200,
      systemPrompt: systemPromptStore.get("sess_sp_test"),
    })!;
    expect(run.inputs.system_prompt).toBe("You are a helpful KB agent.");
    systemPromptStore.delete("sess_sp_test");
    expect(systemPromptStore.get("sess_sp_test")).toBeUndefined();
  });

  it("is withheld when content capture is off", () => {
    const journal = new TurnJournal();
    journal.record("s3", "message.received", { message: "hi" }, 100);
    const run = journal.finalize({
      sessionId: "s3",
      outcome: "answered",
      agentName: "a",
      project: "p",
      recordContent: false,
      now: 200,
      systemPrompt: "SECRET PROMPT",
    })!;
    expect(JSON.stringify(run)).not.toContain("SECRET PROMPT");
  });
});

describe("human span names (§9)", () => {
  it("translates framework names to business language", () => {
    expect(humanSpanName("workflow.route.flow")).toBe("Customer Request Processing");
    expect(humanSpanName("ai.eve.turn")).toBe("Agent Turn: Understanding & Responding");
    expect(humanSpanName("invoke_agent gpt-4.1")).toBe("Agent Reasoning (gpt-4.1)");
    expect(humanSpanName("chat gpt-4.1")).toBe("Generating Response (gpt-4.1)");
    expect(humanSpanName("step 1")).toBe("Attempt 1: Model Call & Tool Selection");
    expect(humanSpanName("execute_tool calculate_division")).toBe("Calling Calculator Tool");
    expect(humanSpanName("execute_tool mystery")).toBe("Calling mystery Tool");
    expect(humanSpanName("workflow.execute turnWorkflow")).toBe("Agent Run (infrastructure)");
    expect(humanSpanName("step.execute turnStep")).toBe("Processing Step (infrastructure)");
    expect(humanSpanName("fetch POST http://127.0.0.1:3000/x")).toBe(
      "Network Call (infrastructure)",
    );
    // Unknown names pass through untouched.
    expect(humanSpanName("something.else")).toBe("something.else");
  });
});
