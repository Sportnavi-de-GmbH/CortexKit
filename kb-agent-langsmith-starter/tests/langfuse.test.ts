// The invariants that matter for the Langfuse integration:
//  1. no credentials = every surface is a silent no-op;
//  2. the OTLP endpoint and Basic auth match Langfuse's documented contract;
//  3. the environment tag is normalized — an invalid one makes Langfuse REJECT
//     the span, which looks exactly like "tracing is broken";
//  4. the span filter keeps what a reader needs and drops eve's plumbing;
//  4b. a trace answers, on its own: which agent, asked what, using which
//     knowledge, doing what steps, returning what, at what cost;
//  5. failures become ERROR-level spans with the story attributes;
//  6. the hook NEVER throws — a thrown hook would itself fail the turn;
//  7. cost is never invented for an unknown model.
//
// What these DON'T prove: that anything reached Langfuse. That is
// scripts/verify-langfuse.ts, which reads the trace back.
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { handlersFor, type EmittedSpan, type SpanEmitter } from "../agent/hooks/langfuse.ts";
import {
  LF,
  LANGFUSE_OTEL_TRACES_PATH,
  dedupeUsage,
  estimateCostUsd,
  failureMessage,
  failureSpan,
  humanSpanName,
  isUsageAggregatorSpan,
  isUsageAttribute,
  langfuseAuthHeader,
  langfuseBaseUrl,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  langfuseObservationType,
  langfuseRecordIo,
  langfuseTracesUrl,
  contextSummary,
  generationInput,
  isMeaningfulSpanName,
  isOversizedAttribute,
  knowledgeSource,
  STEP_PURPOSE,
  turnIoStore,
  shouldExportSpan,
  SPAN,
  traceTitle,
  systemPromptStore,
  traceCompleteness,
  traceRefs,
  TurnJournal,
} from "../lib/langfuse.ts";

const ctx = {
  agent: { name: "test-agent" },
  channel: { kind: "http" },
  session: { id: "sess-test" },
};

const CONFIGURED = {
  LANGFUSE_BASE_URL: "https://langfuse.example.com",
  LANGFUSE_PUBLIC_KEY: "pk-lf-abc",
  LANGFUSE_SECRET_KEY: "sk-lf-xyz",
} as unknown as NodeJS.ProcessEnv;

afterAll(() => {
  rmSync(".data/langfuse-traces", { recursive: true, force: true });
  rmSync(".data/system-prompts", { recursive: true, force: true });
  rmSync(".data/turn-io", { recursive: true, force: true });
});

function recorder(): SpanEmitter & { spans: EmittedSpan[] } {
  const spans: EmittedSpan[] = [];
  return { spans, emit: (s) => void spans.push(s) };
}

describe("enablement — no credentials is a no-op, never an error", () => {
  it("needs host and BOTH keys", () => {
    expect(langfuseEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(langfuseEnabled(CONFIGURED)).toBe(true);
    for (const missing of ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
      const env = { ...CONFIGURED, [missing]: "" } as unknown as NodeJS.ProcessEnv;
      expect(langfuseEnabled(env), `${missing} blank must disable`).toBe(false);
    }
  });

  it("treats whitespace-only credentials as absent", () => {
    expect(langfuseEnabled({ ...CONFIGURED, LANGFUSE_SECRET_KEY: "   " } as unknown as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  it("content capture is off unless explicitly enabled", () => {
    expect(langfuseRecordIo({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(langfuseRecordIo({ LANGFUSE_RECORD_IO: "false" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(langfuseRecordIo({ LANGFUSE_RECORD_IO: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("endpoint + auth contract", () => {
  it("builds the documented OTLP traces URL", () => {
    expect(LANGFUSE_OTEL_TRACES_PATH).toBe("/api/public/otel/v1/traces");
    expect(langfuseTracesUrl(CONFIGURED)).toBe(
      "https://langfuse.example.com/api/public/otel/v1/traces",
    );
  });

  it("tolerates a trailing slash on the host", () => {
    const env = { ...CONFIGURED, LANGFUSE_BASE_URL: "https://langfuse.example.com//" };
    expect(langfuseBaseUrl(env as unknown as NodeJS.ProcessEnv)).toBe("https://langfuse.example.com");
  });

  it("accepts LANGFUSE_HOST as an alias", () => {
    const env = { LANGFUSE_HOST: "https://alt.example.com" } as unknown as NodeJS.ProcessEnv;
    expect(langfuseBaseUrl(env)).toBe("https://alt.example.com");
  });

  it("uses Basic base64(public:secret)", () => {
    const expected = `Basic ${Buffer.from("pk-lf-abc:sk-lf-xyz", "utf8").toString("base64")}`;
    expect(langfuseAuthHeader(CONFIGURED)).toBe(expected);
  });

  it("sends the v4 ingestion-version header (without it traces lag ~10 min)", () => {
    expect(langfuseHeaders(CONFIGURED)["x-langfuse-ingestion-version"]).toBe("4");
  });
});

describe("environment tag — invalid values are REJECTED by Langfuse", () => {
  it("passes through a valid value", () => {
    expect(langfuseEnvironment({ LANGFUSE_TRACING_ENVIRONMENT: "production" } as unknown as NodeJS.ProcessEnv)).toBe(
      "production",
    );
  });

  it("normalizes case and illegal characters", () => {
    expect(
      langfuseEnvironment({ LANGFUSE_TRACING_ENVIRONMENT: "Preview/PR 12" } as unknown as NodeJS.ProcessEnv),
    ).toBe("preview-pr-12");
  });

  it("refuses the reserved `langfuse` prefix", () => {
    expect(
      langfuseEnvironment({ LANGFUSE_TRACING_ENVIRONMENT: "langfuse-test" } as unknown as NodeJS.ProcessEnv),
    ).toBe("development");
  });

  it("caps at 40 characters", () => {
    const long = "a".repeat(80);
    expect(langfuseEnvironment({ LANGFUSE_TRACING_ENVIRONMENT: long } as unknown as NodeJS.ProcessEnv)).toHaveLength(
      40,
    );
  });

  it("falls back to VERCEL_ENV, then NODE_ENV", () => {
    expect(langfuseEnvironment({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv)).toBe("preview");
    expect(langfuseEnvironment({ NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv)).toBe("test");
    expect(langfuseEnvironment({} as unknown as NodeJS.ProcessEnv)).toBe("development");
  });

  it("always satisfies Langfuse's documented pattern", () => {
    const pattern = /^(?!langfuse)[a-z0-9-_]+$/;
    for (const raw of ["Production", "", "LANGFUSE", "a b/c", "!!!", "x".repeat(100)]) {
      expect(langfuseEnvironment({ LANGFUSE_TRACING_ENVIRONMENT: raw } as unknown as NodeJS.ProcessEnv)).toMatch(
        pattern,
      );
    }
  });
});

describe("span filter", () => {
  it("keeps the spans that mean something to a reader", () => {
    expect(shouldExportSpan("ai.streamText", [])).toBe(true);
    expect(shouldExportSpan("chat gpt-4.1", ["gen_ai.request.model"])).toBe(true);
    expect(shouldExportSpan("ai.eve.turn", ["eve.session.id"])).toBe(true);
    expect(shouldExportSpan("workflow.route.flow", [])).toBe(true); // the trace root
    expect(shouldExportSpan(SPAN.summary, ["langfuse.trace.input"])).toBe(true);
    expect(shouldExportSpan("failure:agent-turn", [])).toBe(true);
  });

  it("drops eve runtime plumbing", () => {
    for (const noise of [
      "workflow.execute",
      "workflow.stream.foo",
      "step.execute",
      "step.hydrate",
      "hook.resume",
      "fetch POST",
    ]) {
      expect(shouldExportSpan(noise, []), `${noise} is plumbing`).toBe(false);
      expect(isMeaningfulSpanName(noise)).toBe(false);
    }
  });

  it("does not confuse eve's step.* with the AI SDK's `step N`", () => {
    expect(isMeaningfulSpanName("step 1")).toBe(true);
    expect(isMeaningfulSpanName("step.execute")).toBe(false);
  });

  it("keeps everything in complete mode", () => {
    expect(shouldExportSpan("fetch POST", [], true)).toBe(true);
  });

  it("still keeps anything we deliberately annotated", () => {
    expect(shouldExportSpan("something.unknown", ["app.agent.label"])).toBe(true);
  });
});

describe("span names — describe the work, stay stable", () => {
  it("replaces framework internals with what actually happened", () => {
    expect(humanSpanName("workflow.route.flow")).toBe(SPAN.request);
    expect(humanSpanName("ai.eve.turn")).toBe(SPAN.turn);
    expect(humanSpanName("invoke_agent gpt-4.1")).toBe(SPAN.applyKnowledge);
    expect(humanSpanName("chat gpt-4.1")).toBe(SPAN.generate);
    expect(humanSpanName("step 1")).toBe(SPAN.compose);
  });

  it("never interpolates the model into the name (it would break grouping)", () => {
    for (const model of ["gpt-4.1", "gpt-4o-mini"]) {
      expect(humanSpanName(`chat ${model}`)).not.toContain(model);
      expect(humanSpanName(`invoke_agent ${model}`)).not.toContain(model);
    }
  });

  it("names the knowledge step after the knowledge, so a reader knows where the answer came from", () => {
    expect(SPAN.generate).toBe("generate-answer");
  });

  it("leaves our own span names alone", () => {
    expect(humanSpanName(SPAN.summary)).toBe(SPAN.summary);
    expect(humanSpanName("failure:agent-turn")).toBe("failure:agent-turn");
  });
});

describe("every stage explains itself", () => {
  // Measured on a real trace before this existed: 3 of 6 observations had
  // input: null AND output: null, including the trace root.
  it("has a purpose line for every stage of the flow", () => {
    for (const stage of Object.values(SPAN)) {
      expect(STEP_PURPOSE[stage], `${stage} needs a purpose`).toBeTruthy();
      expect(STEP_PURPOSE[stage]!.length).toBeGreaterThan(30);
    }
  });

  it("puts the knowledge base on the model call, where the answer came from", () => {
    const input = JSON.parse(
      generationInput({
        systemPrompt: "=== KNOWLEDGE BASE ===\nPause: 3 Monate",
        question: "Wie funktioniert die Pause?",
        recordContent: true,
      }),
    );
    expect(input.user_question).toBe("Wie funktioniert die Pause?");
    expect(input.system_prompt).toContain("Pause: 3 Monate");
    expect(input.knowledge_base.version_digest).toHaveLength(12);
    expect(input.knowledge_base.sections).toContain("KNOWLEDGE BASE");
  });

  it("keeps the 73 KB prompt OFF the wrapper spans — one copy, on the model call", () => {
    const summary = JSON.parse(
      contextSummary({
        systemPrompt: "x".repeat(50_000),
        question: "Frage",
        recordContent: true,
      }),
    );
    expect(JSON.stringify(summary).length).toBeLessThan(1_000);
    expect(summary.knowledge_base).toContain("digest");
    expect(summary.retrieval).toContain("none");
  });

  it("redacts visitor text in both shapes when capture is off", () => {
    const gen = JSON.parse(
      generationInput({ systemPrompt: "secret KB", question: "personal", recordContent: false }),
    );
    expect(JSON.stringify(gen)).not.toContain("personal");
    expect(JSON.stringify(gen)).not.toContain("secret KB");
    // …but the fingerprint survives, so you still know WHICH KB answered.
    expect(gen.knowledge_base.version_digest).toHaveLength(12);
  });

  it("drops the framework's replayed prompt blob but never the answer", () => {
    const huge = "x".repeat(79_634);
    expect(isOversizedAttribute("ai.prompt.messages", huge)).toBe(true);
    // Output attributes are kept at ANY size — stripping these silently
    // emptied three spans' outputs on a real trace.
    expect(isOversizedAttribute("ai.response.messages", huge)).toBe(false);
    expect(isOversizedAttribute("gen_ai.completion", huge)).toBe(false);
    // Small values are always kept.
    expect(isOversizedAttribute("ai.prompt.messages", "short")).toBe(false);
    expect(isOversizedAttribute("gen_ai.request.model", 12345)).toBe(false);
  });

  it("bridges the conversation from the hook to the span processor", async () => {
    const emitter = recorder();
    const handlers = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 1 });
    await handlers["message.received"]!({ data: { message: "Wie checke ich ein?" } }, ctx);
    expect(turnIoStore.get(ctx.session.id)?.question).toBe("Wie checke ich ein?");
    await handlers["message.completed"]!({ data: { text: "Scanne den QR-Code" } }, ctx);
    const io = turnIoStore.get(ctx.session.id)!;
    expect(io.question).toBe("Wie checke ich ein?"); // not clobbered by the reply
    expect(io.reply).toBe("Scanne den QR-Code");
  });
});

describe("trace title — the one line a reviewer reads first", () => {
  it("names the agent AND quotes the question", () => {
    const title = traceTitle("Was ist Firmenfitness?", true, 1);
    expect(title).toContain("KB-Agent");
    expect(title).toContain("Was ist Firmenfitness?");
  });

  it("truncates a long question instead of producing an unreadable row", () => {
    const title = traceTitle("x".repeat(400), true, 1);
    expect(title.length).toBeLessThan(120);
    expect(title).toContain("…");
  });

  it("collapses newlines so the trace list stays one line per trace", () => {
    expect(traceTitle("erste Zeile\nzweite Zeile", true, 1)).not.toContain("\n");
  });

  it("leaks NOTHING when content capture is off", () => {
    const title = traceTitle("personal question", false, 2);
    expect(title).not.toContain("personal");
    expect(title).toContain("KB-Agent");
    expect(title).toContain("2");
  });
});

describe("knowledge provenance — there is no retrieval, so say so", () => {
  const prompt = "=== IDENTITY ===\nfoo\n=== KNOWLEDGE BASE ===\nbar\n=== BEHAVIOR RULES ===\nbaz";

  it("fingerprints the prompt so you can tell WHICH KB answered", () => {
    const kb = knowledgeSource(prompt)!;
    expect(kb.digest).toHaveLength(12);
    expect(kb.chars).toBe(String(prompt.length));
    expect(Number(kb.approxTokens)).toBeGreaterThan(0);
  });

  it("changes the digest when the knowledge changes, and only then", () => {
    expect(knowledgeSource(prompt)!.digest).toBe(knowledgeSource(prompt)!.digest);
    expect(knowledgeSource(`${prompt} edited`)!.digest).not.toBe(knowledgeSource(prompt)!.digest);
  });

  it("lists the KB sections actually present", () => {
    expect(knowledgeSource(prompt)!.sections).toContain("KNOWLEDGE BASE");
    expect(knowledgeSource(prompt)!.sections).toContain("BEHAVIOR RULES");
  });

  it("states the mode, so nobody hunts for retrieval spans that cannot exist", () => {
    expect(knowledgeSource(prompt)!.mode).toContain("no retrieval");
  });

  it("returns undefined rather than inventing a source", () => {
    expect(knowledgeSource(undefined)).toBeUndefined();
    expect(knowledgeSource("")).toBeUndefined();
  });
});

describe("observation typing — conservative on purpose", () => {
  it("types eve's turn as an agent and tools as tools", () => {
    expect(langfuseObservationType("ai.eve.turn")).toBe("agent");
    expect(langfuseObservationType("execute_tool find_partners")).toBe("tool");
  });

  it("leaves model calls to Langfuse's own inference — mistyping loses cost", () => {
    expect(langfuseObservationType("chat gpt-4.1")).toBeUndefined();
    expect(langfuseObservationType("invoke_agent gpt-4.1")).toBeUndefined();
  });
});

describe("cost accuracy", () => {
  it("dedupes aggregator usage by default", () => {
    expect(dedupeUsage({} as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(dedupeUsage({ LANGFUSE_DEDUPE_USAGE: "false" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isUsageAggregatorSpan("invoke_agent gpt-4.1")).toBe(true);
    expect(isUsageAggregatorSpan("chat gpt-4.1")).toBe(false);
    expect(isUsageAttribute("gen_ai.usage.input_tokens")).toBe(true);
    expect(isUsageAttribute("gen_ai.request.model")).toBe(false);
  });

  it("never invents a price for an unknown model", () => {
    expect(estimateCostUsd("some-unlisted-model", 1000, 1000)).toBe(0);
  });

  it("prices cached input at the cheaper rate", () => {
    const full = estimateCostUsd("gpt-4.1", 1000, 0, 0);
    const cached = estimateCostUsd("gpt-4.1", 1000, 0, 1000);
    expect(cached).toBeLessThan(full);
  });
});

describe("failure spans", () => {
  it("normalizes both eve failure payload shapes", () => {
    expect(failureMessage({ message: "boom", code: "E1" }, "fallback")).toEqual({
      message: "boom",
      code: "E1",
    });
    expect(failureMessage("raw", "fallback").message).toBe("raw");
    expect(failureMessage(undefined, "fallback").message).toBe("fallback");
  });

  it("carries the ERROR level and the story attributes", () => {
    const span = failureSpan({
      kind: "turn",
      subject: "turn_error",
      data: { message: "Azure 429", code: "rate_limited" },
      sessionId: "sess-1",
      agentName: "navio",
      channelKind: "http",
      env: CONFIGURED,
    });
    expect(span.attributes[LF.observationLevel]).toBe("ERROR");
    expect(span.attributes[LF.sessionId]).toBe("sess-1");
    expect(span.statusMessage).toBe("[rate_limited] Azure 429");
    // A 429 is classified, not shrugged at — the trace should name the cause.
    expect(span.attributes["app.error_type"]).toBe("upstream_unavailable");
    expect(span.attributes["app.error_cause"]).toContain("429");
    expect(span.attributes["app.recommended_action"]).toContain("TPM");
    expect(span.attributes["app.user_impact"]).toContain("did not get an answer");
  });

  it("classifies the failures this agent actually hits", () => {
    const classify = (message: string) =>
      failureSpan({
        kind: "turn",
        subject: "turn_error",
        data: { message },
        sessionId: "s",
        agentName: "navio",
      }).attributes["app.error_type"];

    expect(classify("Access denied due to invalid subscription key")).toBe("permission_denied");
    expect(classify("429 Too Many Requests")).toBe("upstream_unavailable");
    expect(classify("The operation timed out")).toBe("timeout");
  });

  it("says 'unexpected' rather than guessing when it does not recognise the error", () => {
    const span = failureSpan({
      kind: "turn",
      subject: "turn_error",
      data: { message: "something nobody has seen before" },
      sessionId: "s",
      agentName: "navio",
    });
    expect(span.attributes["app.error_type"]).toBe("unexpected");
    expect(span.attributes["app.error_cause"]).toContain("Not a recognised");
  });

  it("keeps the name stable so failures group — the message goes to status", () => {
    const one = failureSpan({
      kind: "turn",
      subject: "turn_error",
      data: { message: "first failure" },
      sessionId: "s",
      agentName: "navio",
    });
    const two = failureSpan({
      kind: "turn",
      subject: "turn_error",
      data: { message: "a completely different failure" },
      sessionId: "s",
      agentName: "navio",
    });
    expect(one.name).toBe(two.name);
    expect(one.name).not.toContain("first failure");
    expect(one.statusMessage).not.toBe(two.statusMessage);
  });
});

describe("turn journal", () => {
  it("summarises a turn with tokens, steps and outcome", () => {
    const j = new TurnJournal();
    j.record("s", "message.received", { message: "Was ist Firmenfitness?" }, 1_000);
    j.record("s", "step.completed", { usage: { inputTokens: 100, outputTokens: 20 } }, 1_500);
    j.record("s", "message.completed", { text: "Firmenfitness ist …" }, 2_000);
    const summary = j.finalize({
      sessionId: "s",
      outcome: "answered",
      agentName: "navio",
      channelKind: "http",
      recordContent: true,
      now: 2_100,
      env: CONFIGURED,
    });
    expect(summary).toBeDefined();
    expect(summary!.name).toBe(SPAN.summary);
    expect(summary!.attributes[LF.traceInput]).toBe("Was ist Firmenfitness?");
    expect(summary!.attributes[LF.traceOutput]).toBe("Firmenfitness ist …");
    expect(summary!.attributes["langfuse.trace.metadata.tokens.total"]).toBe("120");
    expect(summary!.attributes["langfuse.trace.metadata.outcome"]).toBe("answered");
    expect(summary!.attributes[LF.traceTags]).toContain("navio");
  });

  // The acceptance criteria, as a test: someone reading ONLY the trace must be
  // able to answer each of these without opening the code.
  it("answers every question a reader has, on the trace itself", () => {
    const j = new TurnJournal();
    j.record("q", "message.received", { message: "Wie checke ich ein?" }, 1_000);
    j.record("q", "message.appended", { text: "Der" }, 1_400);
    j.record("q", "step.completed", { usage: { inputTokens: 17_000, outputTokens: 200 } }, 1_800);
    j.record("q", "message.completed", { text: "Scanne den QR-Code …" }, 2_000);
    const a = j.finalize({
      sessionId: "q",
      outcome: "answered",
      agentName: "kb-agent-langsmith-starter",
      channelKind: "http",
      recordContent: true,
      now: 2_100,
      systemPrompt: "=== KNOWLEDGE BASE ===\nFAQ text",
      env: { ...CONFIGURED, AZURE_AI_CHATBOT_DEPLOYMENT_NAME: "gpt-4o-mini" } as unknown as NodeJS.ProcessEnv,
    })!.attributes;

    // which agent
    expect(a["langfuse.trace.metadata.agent"]).toBe("KB-Agent");
    expect(a["langfuse.trace.metadata.agent.role"]).toContain("Sportnavi");
    // what the user requested / what was returned
    expect(a[LF.traceInput]).toBe("Wie checke ich ein?");
    expect(a[LF.traceOutput]).toContain("QR-Code");
    // which knowledge source, and what was retrieved
    expect(a["langfuse.trace.metadata.knowledge.source"]).toContain("instructions.md");
    expect(String(a["langfuse.trace.metadata.knowledge.version_digest"])).toHaveLength(12);
    expect(a["langfuse.trace.metadata.knowledge.retrieved"]).toContain("no lookup");
    // which tools
    expect(a["langfuse.trace.metadata.tools.available"]).toContain("0");
    expect(a["langfuse.trace.metadata.tools.called"]).toBe("none");
    // steps performed
    expect(a["langfuse.trace.metadata.steps.model_calls"]).toBe("1");
    // timing + status
    expect(a["langfuse.trace.metadata.timing.duration_ms"]).toBe("1100");
    expect(a["langfuse.trace.metadata.timing.first_token_ms"]).toBe("400");
    expect(a["langfuse.trace.metadata.outcome"]).toBe("answered");
    // model + cost
    expect(a["langfuse.trace.metadata.model"]).toBe("gpt-4o-mini");
    expect(Number(a["langfuse.trace.metadata.cost.estimate_usd"])).toBeGreaterThan(0);
  });

  it("reports first-token timing honestly when nothing streamed", () => {
    const j = new TurnJournal();
    j.record("nt", "message.received", { message: "hi" }, 0);
    j.record("nt", "step.completed", { usage: {} }, 10);
    const a = j.finalize({
      sessionId: "nt",
      outcome: "failed",
      agentName: "navio",
      recordContent: true,
      now: 20,
      env: CONFIGURED,
    })!.attributes;
    expect(a["langfuse.trace.metadata.timing.first_token_ms"]).toBe("not observed");
  });

  it("keeps the full system prompt OUT of the trace unless explicitly asked", () => {
    const j = new TurnJournal();
    j.record("sp", "message.received", { message: "hi" }, 0);
    const attrs = j.finalize({
      sessionId: "sp",
      outcome: "answered",
      agentName: "navio",
      recordContent: true,
      now: 5,
      systemPrompt: "=== KNOWLEDGE BASE ===\nthe entire 16.7k-token KB",
      env: CONFIGURED,
    })!.attributes;
    expect(attrs["app.system_prompt"]).toBeUndefined();
    // …but its fingerprint is always there.
    expect(attrs["langfuse.trace.metadata.knowledge.version_digest"]).toBeDefined();
  });

  it("redacts content when capture is off", () => {
    const j = new TurnJournal();
    j.record("s2", "message.received", { message: "personal data" }, 1_000);
    j.record("s2", "message.completed", { text: "reply" }, 1_100);
    const summary = j.finalize({
      sessionId: "s2",
      outcome: "answered",
      agentName: "navio",
      recordContent: false,
      now: 1_200,
      env: CONFIGURED,
    });
    expect(String(summary!.attributes[LF.traceInput])).not.toContain("personal data");
    expect(String(summary!.attributes[LF.traceOutput])).not.toContain("reply");
  });

  it("produces nothing when nothing was journaled", () => {
    const j = new TurnJournal();
    expect(
      j.finalize({
        sessionId: "never-seen",
        outcome: "answered",
        agentName: "navio",
        recordContent: true,
        now: 1,
      }),
    ).toBeUndefined();
  });
});

describe("hook", () => {
  it("emits a summary span attached to the session's trace", async () => {
    const emitter = recorder();
    traceRefs.set(ctx.session.id, { traceId: "a".repeat(32), rootSpanId: "b".repeat(16) });
    const handlers = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 5 });

    await handlers["message.received"]!({ data: { message: "hi" } }, ctx);
    await handlers["turn.completed"]!({}, ctx);

    const summary = emitter.spans.find((s) => s.name === SPAN.summary);
    expect(summary).toBeDefined();
    expect(summary!.traceRef?.traceId).toBe("a".repeat(32));
    expect(summary!.traceRef?.rootSpanId).toBe("b".repeat(16));
  });

  it("emits an ERROR span for a failed turn, then the summary", async () => {
    const emitter = recorder();
    traceRefs.set(ctx.session.id, { traceId: "c".repeat(32), rootSpanId: "d".repeat(16) });
    const handlers = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 7 });

    await handlers["message.received"]!({ data: { message: "hi" } }, ctx);
    await handlers["turn.failed"]!({ data: { code: "turn_error", message: "boom" } }, ctx);

    expect(emitter.spans.map((s) => s.name)).toEqual(["failure:agent-turn", SPAN.summary]);
    expect(emitter.spans[0]!.error).toContain("boom");
    expect(emitter.spans[0]!.attributes[LF.observationLevel]).toBe("ERROR");
    // Both spans must land on the SAME trace as the model calls.
    expect(emitter.spans[1]!.traceRef?.traceId).toBe("c".repeat(32));
  });

  it("keeps a failed session on ONE trace (session.failed arrives after the ref is cleared)", async () => {
    // Regression: turn.failed ends the turn and clears the on-disk ref, so the
    // session.failed span that follows found no parent and opened a SECOND
    // trace. Reproduced live on 2026-08-12 — one request, two traces.
    const emitter = recorder();
    const traceId = "1".repeat(32);
    traceRefs.set(ctx.session.id, { traceId, rootSpanId: "2".repeat(16) });
    const handlers = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 9 });

    await handlers["message.received"]!({ data: { message: "hi" } }, ctx);
    await handlers["turn.failed"]!({ data: { code: "MODEL_CALL_FAILED" } }, ctx);
    await handlers["session.failed"]!({ data: { code: "MODEL_CALL_FAILED" } }, ctx);

    expect(emitter.spans.length).toBeGreaterThanOrEqual(3);
    const traceIds = new Set(emitter.spans.map((s) => s.traceRef?.traceId));
    expect(traceIds).toEqual(new Set([traceId]));
  });

  it("ignores successful tool results — they are already on the trace", async () => {
    const emitter = recorder();
    const handlers = handlersFor(emitter, new TurnJournal(), { now: () => 1 });
    await handlers["action.result"]!({ data: { result: { toolName: "t", isError: false } } }, ctx);
    expect(emitter.spans).toHaveLength(0);
  });

  it("NEVER throws, even when the emitter explodes", async () => {
    const exploding: SpanEmitter = {
      emit() {
        throw new Error("otel exploded");
      },
    };
    const handlers = handlersFor(exploding, new TurnJournal(), { now: () => 1 });
    for (const [name, handler] of Object.entries(handlers)) {
      await expect(
        handler({ data: { result: { isError: true, toolName: "t" } } }, ctx),
        `${name} must swallow`,
      ).resolves.toBeUndefined();
    }
  });

  it("survives a malformed context", async () => {
    const emitter = recorder();
    const handlers = handlersFor(emitter, new TurnJournal(), { now: () => 1 });
    await expect(
      handlers["turn.failed"]!({ data: {} }, { session: { id: "x" } } as never),
    ).resolves.toBeUndefined();
  });
});

describe("cross-bundle stores (instrumentation writes, the hook reads)", () => {
  it("round-trips a trace ref through the filesystem", () => {
    traceRefs.set("sess-store", { traceId: "e".repeat(32), rootSpanId: "f".repeat(16) });
    expect(traceRefs.get("sess-store")?.traceId).toBe("e".repeat(32));
    traceRefs.delete("sess-store");
    expect(traceRefs.get("sess-store")).toBeUndefined();
  });

  it("round-trips the system prompt", () => {
    systemPromptStore.set("sess-store", "SYSTEM");
    expect(systemPromptStore.get("sess-store")).toBe("SYSTEM");
    systemPromptStore.delete("sess-store");
  });

  it("returns undefined rather than throwing for an unknown session", () => {
    expect(traceRefs.get("no-such-session")).toBeUndefined();
    expect(systemPromptStore.get("no-such-session")).toBeUndefined();
  });
});

describe("trace completeness", () => {
  // Measured: with structural spans on, one FAQ turn was 112 observations,
  // 89 of them eve transport chatter. Lean is the default for a reason.
  it("defaults to lean — structural spans are opt-in", () => {
    expect(traceCompleteness({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(
      traceCompleteness({ LANGFUSE_TRACE_COMPLETENESS: "ai" } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      traceCompleteness({ LANGFUSE_TRACE_COMPLETENESS: "complete" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});
