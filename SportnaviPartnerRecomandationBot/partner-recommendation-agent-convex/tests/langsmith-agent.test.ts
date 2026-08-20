import { describe, expect, it } from "vitest";

import {
  appMetadata,
  childAttachment,
  dottedStampFromHr,
  failureRunPayload,
  humanSpanName,
  langsmithEnabled,
  otelRunId,
  projectName,
  recordIo,
  rootAttachment,
  shouldExportSpan,
  SpanFilterState,
  TurnJournal,
  type LangSmithRunPayload,
  type TraceAnchor,
} from "../lib/langsmith";
import { handlersFor, type LangSmithLike } from "../agent/hooks/langsmith";

/** Minimal, isolated env fixture — NODE_ENV is required by Next.js's global
 *  ProcessEnv augmentation (node_modules/next/types/global.d.ts). */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

describe("langsmithEnabled / projectName / recordIo", () => {
  it("is disabled without a key and enabled with one", () => {
    expect(langsmithEnabled(env())).toBe(false);
    expect(langsmithEnabled(env({ LANGSMITH_API_KEY: "  " }))).toBe(false);
    expect(langsmithEnabled(env({ LANGSMITH_API_KEY: "lsv2_pt_x" }))).toBe(true);
  });

  it("falls back to the project default when unset", () => {
    expect(projectName(env())).toBe("sportnavi-partner-recommendationbot-development");
    expect(projectName(env({ LANGSMITH_PROJECT: "custom-project" }))).toBe("custom-project");
  });

  it("defaults content capture to off (privacy)", () => {
    expect(recordIo(env())).toBe(false);
    expect(recordIo(env({ LANGSMITH_RECORD_IO: "true" }))).toBe(true);
  });
});

describe("appMetadata", () => {
  it("surfaces model/version/environment for filtering", () => {
    const meta = appMetadata(env({ AZURE_AI_CHATBOT_DEPLOYMENT_NAME: "gpt-4.1" }));
    expect(meta["app.model"]).toBe("gpt-4.1");
    expect(meta["app.environment"]).toBe("test");
  });
});

describe("shouldExportSpan", () => {
  it("keeps ai.* spans and spans carrying gen_ai./ai./eve./app. attributes", () => {
    expect(shouldExportSpan("ai.eve.turn", [])).toBe(true);
    expect(shouldExportSpan("chat gpt-4.1", ["gen_ai.request.model"])).toBe(true);
    expect(shouldExportSpan("invoke_agent gpt-4.1", ["ai.model.id"])).toBe(true);
  });

  it("drops workflow infrastructure spans", () => {
    expect(shouldExportSpan("workflow.route.flow", ["http.method"])).toBe(false);
    expect(shouldExportSpan("fetch POST ...", [])).toBe(false);
  });
});

describe("SpanFilterState (tree-decision filtering)", () => {
  it("marks the whole ancestor chain of a kept AI span as must-export", () => {
    const state = new SpanFilterState();
    state.onStart("root", undefined);
    state.onStart("parent", "root");
    state.onStart("ai-child", "parent");

    // The AI child ends first (children end before parents) and is kept.
    expect(state.onEnd("ai-child", "parent", true)).toBe(true);

    // Its ancestors, ending later with their OWN verdict false, are still
    // exported because they were marked must-export.
    expect(state.onEnd("parent", "root", false)).toBe(true);
    expect(state.onEnd("root", undefined, false)).toBe(true);
  });

  it("drops a subtree with no AI descendants", () => {
    const state = new SpanFilterState();
    state.onStart("root", undefined);
    state.onStart("noise-child", "root");

    expect(state.onEnd("noise-child", "root", false)).toBe(false);
    expect(state.onEnd("root", undefined, false)).toBe(false);
  });
});

describe("humanSpanName", () => {
  it("rewrites known framework span names for humans", () => {
    expect(humanSpanName("invoke_agent gpt-4.1")).toBe("Agent Reasoning (gpt-4.1)");
    expect(humanSpanName("chat gpt-4.1")).toBe("Generating Response (gpt-4.1)");
    expect(humanSpanName("ai.eve.turn")).toBe("Agent Turn: Understanding & Responding");
    expect(humanSpanName("workflow.execute")).toBe("Agent Run (infrastructure)");
  });

  it("passes through names it doesn't recognize, e.g. a tool's own span name", () => {
    expect(humanSpanName("resolve_partners")).toBe("resolve_partners");
  });

  it("renames the turn span eve 0.25.x actually emits (`eve.turn`, not `ai.eve.turn`)", () => {
    expect(humanSpanName("eve.turn")).toBe("Agent Turn: Understanding & Responding");
  });

  it("numbers the AI SDK's bare `step N` spans", () => {
    expect(humanSpanName("step 1")).toBe("Processing Step 1");
    expect(humanSpanName("step 12")).toBe("Processing Step 12");
    // The workflow-infrastructure span keeps its own, different label.
    expect(humanSpanName("step.execute turnStep")).toBe("Processing Step (infrastructure)");
  });
});

describe("trace anchors (Part C — one trace per request)", () => {
  it("reproduces LangSmith's deterministic spanId -> runId mapping", () => {
    // Measured against this project's live trace on 2026-07-31.
    expect(otelRunId("5aa1f8b8562d7ee8")).toBe("00000000-0000-0000-5aa1-f8b8562d7ee8");
  });

  it("builds a dotted_order stamp from an OTel hrTime", () => {
    // 2026-07-31T10:12:02.274000Z
    expect(dottedStampFromHr(1785492722, 274_000_000)).toBe("20260731T101202274000Z");
  });

  it("makes the summary run BE the root, and failures its children", () => {
    const anchor: TraceAnchor = {
      rootRunId: "00000000-0000-0000-5aa1-f8b8562d7ee8",
      rootDotted: "20260731T101202274000Z00000000-0000-0000-5aa1-f8b8562d7ee8",
      rootStartMs: 1785492722274,
    };

    const root = rootAttachment(anchor);
    expect(root.id).toBe(anchor.rootRunId);
    expect(root.trace_id).toBe(anchor.rootRunId);
    expect(root.parent_run_id).toBeUndefined(); // a root has no parent
    expect(root.dotted_order).toBe(anchor.rootDotted);

    const child = childAttachment(anchor, "11111111-2222-3333-4444-555555555555", 1785492725000);
    expect(child.trace_id).toBe(anchor.rootRunId);
    expect(child.parent_run_id).toBe(anchor.rootRunId);
    expect(child.dotted_order).toBe(
      `${anchor.rootDotted}.20260731T101205000000Z11111111-2222-3333-4444-555555555555`,
    );
  });

  it("degrades to standalone runs when no anchor exists", () => {
    expect(rootAttachment(undefined)).toEqual({});
    expect(childAttachment(undefined, "r", 0)).toEqual({});
  });
});

describe("failureRunPayload", () => {
  const base = {
    sessionId: "s1",
    agentName: "Navio",
    project: "sportnavi-partner-recommendationbot-development",
    now: 1000,
  };

  it("builds a story-form name and full metadata for a known tool failure", () => {
    const payload = failureRunPayload({
      ...base,
      kind: "tool",
      subject: "resolve_partners",
      data: "supabase: connection refused",
    });

    expect(payload.name).toBe("Partner Resolution Tool Failed: supabase: connection refused");
    expect(payload.run_type).toBe("chain");
    expect(payload.error).toBe("supabase: connection refused");
    const metadata = (payload.extra as any).metadata;
    expect(metadata.error_type).toBe("upstream_unavailable");
    expect(metadata.user_goal).toMatch(/Find enough matching partners/);
    expect(metadata.recommended_action).toBeTruthy();
    expect(metadata.thread_id).toBe("s1");
  });

  it("falls back to a generic story for an unknown tool", () => {
    const payload = failureRunPayload({
      ...base,
      kind: "tool",
      subject: "some_new_tool",
      data: { code: "TOOL_ERROR", message: "boom" },
    });
    expect(payload.name).toBe("some_new_tool Tool Failed: boom");
    expect(payload.error).toBe("[TOOL_ERROR] boom");
  });

  it("labels turn/session/step failures by kind", () => {
    const payload = failureRunPayload({
      ...base,
      kind: "turn",
      subject: "MODEL_CALL_FAILED",
      data: { code: "MODEL_CALL_FAILED", message: "rate limit" },
    });
    expect(payload.name).toBe("Agent Turn (MODEL_CALL_FAILED) Failed: rate limit");
  });
});

describe("TurnJournal", () => {
  it("resets per session on a new message and accumulates tokens/tools across the turn", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "find yoga in Berlin" }, 100);
    journal.record("s1", "step.completed", { usage: { inputTokens: 10, outputTokens: 5 } }, 200);
    journal.record("s1", "step.completed", { usage: { inputTokens: 20, outputTokens: 8 } }, 300);
    journal.record(
      "s1",
      "action.result",
      { result: { toolName: "resolve_partners", isError: false } },
      250,
    );
    // eve's real field name is `message` (string | null), not `text`.
    journal.record("s1", "message.completed", { message: "Here are some studios..." }, 400);

    const payload = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "Navio",
      project: "sportnavi-partner-recommendationbot-development",
      recordContent: true,
      now: 500,
    });

    expect(payload?.name).toBe('Customer Request: "find yoga in Berlin"');
    expect((payload?.outputs as any).agent_reply).toBe("Here are some studios...");
    const metadata = (payload?.extra as any).metadata;
    expect(metadata["app.tokens.total"]).toBe(43);
    expect(metadata["app.tools_used"]).toBe("resolve_partners");
    expect(metadata["app.model_steps"]).toBe(2);
    expect(metadata["app.trace_shape"]).toBe("standalone");
  });

  it("falls back to the streamed text when message.completed carries a null message", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "hi" }, 0);
    journal.record("s1", "message.appended", { messageDelta: "Hel", messageSoFar: "Hel" }, 1);
    journal.record("s1", "message.appended", { messageDelta: "lo!", messageSoFar: "Hello!" }, 2);
    journal.record("s1", "message.completed", { message: null }, 3);

    const payload = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "Navio",
      project: "p",
      recordContent: true,
      now: 4,
    });
    expect((payload?.outputs as any).agent_reply).toBe("Hello!");
  });

  it("records a clarifying question as the output and marks the turn asked_user", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "best yoga studio" }, 0);
    journal.record(
      "s1",
      "input.requested",
      {
        requests: [
          {
            prompt: "In which city are you looking for a yoga studio?",
            options: [{ id: "dortmund", label: "Dortmund" }, { id: "berlin", label: "Berlin" }],
            action: { kind: "tool-call", toolName: "ask_question" },
          },
        ],
      },
      1,
    );

    const payload = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "Navio",
      project: "p",
      recordContent: true,
      now: 2,
    });

    const outputs = payload?.outputs as any;
    expect(outputs.outcome).toBe("asked_user");
    expect(outputs.agent_question).toBe("In which city are you looking for a yoga studio?");
    expect(outputs.agent_reply).toBe("In which city are you looking for a yoga studio?");
    expect(outputs.agent_question_options).toEqual(["Dortmund", "Berlin"]);
    expect((payload?.extra as any).metadata["app.outcome"]).toBe("asked_user");
  });

  it("keeps outcome=answered when the agent both asked and replied", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "hi" }, 0);
    journal.record("s1", "input.requested", { requests: [{ prompt: "Which city?" }] }, 1);
    journal.record("s1", "message.completed", { message: "Here you go." }, 2);

    const payload = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "Navio",
      project: "p",
      recordContent: true,
      now: 3,
    });
    expect((payload?.outputs as any).outcome).toBe("answered");
    expect((payload?.outputs as any).agent_reply).toBe("Here you go.");
  });

  it("becomes the OTLP trace root when an anchor is supplied", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "dortmund" }, 100);

    const anchor: TraceAnchor = {
      rootRunId: "00000000-0000-0000-5aa1-f8b8562d7ee8",
      rootDotted: "20260731T101202274000Z00000000-0000-0000-5aa1-f8b8562d7ee8",
      rootStartMs: 1785492722274,
    };
    const payload = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "Navio",
      project: "p",
      recordContent: true,
      anchor,
      now: 1785492734000,
    });

    expect((payload as any).id).toBe(anchor.rootRunId);
    expect((payload as any).trace_id).toBe(anchor.rootRunId);
    expect((payload as any).dotted_order).toBe(anchor.rootDotted);
    // Must span the whole request, not just from the hook's first event.
    expect(payload?.start_time).toBe(anchor.rootStartMs);
    expect((payload?.extra as any).metadata["app.trace_shape"]).toBe("anchored");
  });

  it("carries cache tokens and provider cost through from step.completed", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "hi" }, 0);
    journal.record(
      "s1",
      "step.completed",
      {
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 80,
          cacheWriteTokens: 5,
          costUsd: 0.002,
        },
      },
      1,
    );
    const metadata = (
      journal.finalize({
        sessionId: "s1",
        outcome: "answered",
        agentName: "Navio",
        project: "p",
        recordContent: true,
        now: 2,
      })?.extra as any
    ).metadata;

    expect(metadata["app.tokens.cache_read"]).toBe(80);
    expect(metadata["app.tokens.cache_write"]).toBe(5);
    expect(metadata["app.provider_cost_usd"]).toBe(0.002);
    expect(metadata["app.finish_reason"]).toBe("stop");
  });

  it("redacts content when recordContent is false but keeps counts", () => {
    const journal = new TurnJournal();
    journal.record("s1", "message.received", { message: "secret request" }, 0);
    const payload = journal.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "Navio",
      project: "p",
      recordContent: false,
      now: 10,
    });
    expect(payload?.name).toBe("Customer Request");
    expect(payload?.inputs).toEqual({});
    expect((payload?.outputs as any).outcome).toBe("answered");
  });

  it("returns undefined when finalize is called with no active turn", () => {
    const journal = new TurnJournal();
    expect(
      journal.finalize({
        sessionId: "never-started",
        outcome: "answered",
        agentName: "Navio",
        project: "p",
        recordContent: true,
        now: 0,
      }),
    ).toBeUndefined();
  });
});

function fakeClient(): { client: LangSmithLike; runs: LangSmithRunPayload[] } {
  const runs: LangSmithRunPayload[] = [];
  return {
    runs,
    client: {
      createRun: async (payload) => {
        runs.push(payload);
        return "run-id";
      },
    },
  };
}

const ctx = { agent: { name: "Navio" }, channel: { kind: "eve" }, session: { id: "s1" } };

describe("langsmith hook", () => {
  it("creates a failure run for a failing tool but not for a successful one", async () => {
    const { client, runs } = fakeClient();
    const handlers = handlersFor(client, "test-project");

    await handlers["action.result"](
      { data: { result: { isError: false, toolName: "extract_city" } } },
      ctx,
    );
    expect(runs).toHaveLength(0);

    await handlers["action.result"](
      {
        data: { result: { isError: true, toolName: "resolve_partners", output: "supabase down" } },
      },
      ctx,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].error).toBe("supabase down");
  });

  it("emits one summary run per completed turn, reflecting recordContent", async () => {
    const { client, runs } = fakeClient();
    const handlers = handlersFor(client, "test-project", undefined, { recordContent: true });

    await handlers["message.received"]({ data: { message: "find yoga" } }, ctx);
    await handlers["step.completed"]({ data: { usage: { inputTokens: 5, outputTokens: 5 } } }, ctx);
    await handlers["message.completed"]({ data: { message: "here you go" } }, ctx);
    await handlers["turn.completed"]({ data: {} }, ctx);

    expect(runs).toHaveLength(1);
    expect(runs[0].name).toBe('Customer Request: "find yoga"');
    expect((runs[0].outputs as any).agent_reply).toBe("here you go");
  });

  it("is a no-op without a client (no API key)", async () => {
    const handlers = handlersFor(undefined, "test-project");
    await expect(
      handlers["turn.failed"]({ data: { code: "X", message: "boom" } }, ctx),
    ).resolves.toBeUndefined();
  });

  it("never lets a throwing client escape the hook (iron rule)", async () => {
    const throwing: LangSmithLike = {
      createRun: async () => {
        throw new Error("langsmith down");
      },
    };
    const handlers = handlersFor(throwing, "test-project");
    for (const name of Object.keys(handlers)) {
      await expect(handlers[name]({ data: {} }, ctx)).resolves.toBeUndefined();
    }
  });
});
