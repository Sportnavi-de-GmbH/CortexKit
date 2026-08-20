// The Langfuse integration's invariants, offline.
//
// These assert BEHAVIOUR of the pure functions the runtime pipes are built
// from — naming, filtering, redaction, classification, the summary payload.
// They deliberately cannot prove that traces arrive: that requires reading
// data back from the running instance, which is scripts/verify-langfuse.ts's
// job. A green run here plus a green run there is the pair that means "it
// works"; either alone does not.
import { describe, expect, it } from "vitest";

import {
  LF,
  MAX_ATTRIBUTE_CHARS,
  PARTNER_AGENT_LABEL,
  SPAN,
  STEP_PURPOSE,
  TOOL_STORIES,
  TurnJournal,
  appMetadata,
  contextSummary,
  estimateCostUsd,
  failureSpan,
  generationInput,
  humanSpanName,
  isMeaningfulSpanName,
  isOversizedAttribute,
  isTurnScopedSpanName,
  isUsageAggregatorSpan,
  isUsageAttribute,
  knowledgeSource,
  langfuseAuthHeader,
  langfuseBaseUrl,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  langfuseObservationType,
  langfuseRecordIo,
  langfuseRecordSystemPrompt,
  langfuseTracesUrl,
  retrievalFactsFrom,
  retrievalSummary,
  shouldExportSpan,
  traceMetadata,
  traceTitle,
} from "../lib/langfuse";
import { handlersFor, type EmittedSpan, type SpanEmitter } from "../agent/hooks/langfuse";

/** Minimal, isolated env fixture — NODE_ENV is required by Next.js's global
 *  ProcessEnv augmentation (node_modules/next/types/global.d.ts). */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

const CREDS = {
  LANGFUSE_BASE_URL: "https://sportnavi-langfuse.sportnavi.de",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
};

// ---------------------------------------------------------------------------
// Enablement — the no-op invariant
// ---------------------------------------------------------------------------

describe("enablement", () => {
  it("is a complete no-op without credentials, so a fresh clone runs", () => {
    expect(langfuseEnabled(env())).toBe(false);
    expect(langfuseEnabled(env({ LANGFUSE_BASE_URL: CREDS.LANGFUSE_BASE_URL }))).toBe(false);
  });

  it("needs the host AND both keys — a half-configured env stays off", () => {
    expect(
      langfuseEnabled(
        env({ LANGFUSE_BASE_URL: CREDS.LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY: "pk-lf-test" }),
      ),
    ).toBe(false);
    expect(
      langfuseEnabled(
        env({ LANGFUSE_BASE_URL: CREDS.LANGFUSE_BASE_URL, LANGFUSE_SECRET_KEY: "sk-lf-test" }),
      ),
    ).toBe(false);
    expect(langfuseEnabled(env(CREDS))).toBe(true);
  });

  it("treats whitespace-only keys as absent", () => {
    expect(
      langfuseEnabled(env({ ...CREDS, LANGFUSE_PUBLIC_KEY: "   ", LANGFUSE_SECRET_KEY: "  " })),
    ).toBe(false);
  });

  it("accepts LANGFUSE_HOST as an alias and strips trailing slashes", () => {
    expect(langfuseBaseUrl(env({ LANGFUSE_HOST: "https://lf.example.com///" }))).toBe(
      "https://lf.example.com",
    );
  });
});

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

describe("OTLP transport contract", () => {
  it("posts to the signal-specific traces path", () => {
    expect(langfuseTracesUrl(env(CREDS))).toBe(
      "https://sportnavi-langfuse.sportnavi.de/api/public/otel/v1/traces",
    );
  });

  it("authenticates with Basic base64(publicKey:secretKey)", () => {
    const expected = `Basic ${Buffer.from("pk-lf-test:sk-lf-test", "utf8").toString("base64")}`;
    expect(langfuseAuthHeader(env(CREDS))).toBe(expected);
  });

  it("always sends the v4 ingestion-version header — without it traces lag ~10min", () => {
    expect(langfuseHeaders(env(CREDS))["x-langfuse-ingestion-version"]).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// Environment tag — an invalid value makes Langfuse REJECT the span
// ---------------------------------------------------------------------------

describe("environment normalisation", () => {
  it("passes a valid value through", () => {
    expect(langfuseEnvironment(env({ LANGFUSE_TRACING_ENVIRONMENT: "production" }))).toBe(
      "production",
    );
  });

  it("rewrites characters the documented pattern forbids", () => {
    expect(langfuseEnvironment(env({ LANGFUSE_TRACING_ENVIRONMENT: "Pre Prod!" }))).toBe(
      "pre-prod-",
    );
  });

  it("refuses the reserved `langfuse` prefix rather than getting the span dropped", () => {
    expect(langfuseEnvironment(env({ LANGFUSE_TRACING_ENVIRONMENT: "langfuse-internal" }))).toBe(
      "development",
    );
  });

  it("caps at the documented 40 characters", () => {
    expect(langfuseEnvironment(env({ LANGFUSE_TRACING_ENVIRONMENT: "a".repeat(80) }))).toHaveLength(
      40,
    );
  });

  it("falls back through VERCEL_ENV then NODE_ENV", () => {
    expect(langfuseEnvironment(env({ VERCEL_ENV: "preview" }))).toBe("preview");
    expect(langfuseEnvironment(env({ NODE_ENV: "test" }))).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Span naming — the partner agent's real flow
// ---------------------------------------------------------------------------

describe("span naming", () => {
  it("renames eve/AI-SDK plumbing to what actually happened", () => {
    expect(humanSpanName("workflow.route.flow")).toBe(SPAN.request);
    expect(humanSpanName("ai.eve.turn")).toBe(SPAN.turn);
    expect(humanSpanName("invoke_agent gpt-4o-mini")).toBe(SPAN.recommend);
    expect(humanSpanName("chat gpt-4o-mini")).toBe(SPAN.generate);
  });

  // Regression: this was originally "step 1 = decide, step 2 = write", which a
  // live trace disproved — the AI SDK restarts step numbering inside each
  // `invoke_agent`, so a two-pass search turn emits "step 1" twice and never
  // "step 2". One stable name is the honest mapping.
  it("gives every AI-SDK step ONE stable name (numbering restarts per pass)", () => {
    expect(humanSpanName("step 1")).toBe(SPAN.step);
    expect(humanSpanName("step 2")).toBe(SPAN.step);
    expect(humanSpanName("step 3")).toBe(SPAN.step);
  });

  // Regression: eve emits authored tool spans under the BARE tool name, so the
  // `execute_tool <name>` pattern alone left them unrenamed on a live trace.
  it("names both real tools whether eve emits them bare or prefixed", () => {
    expect(humanSpanName("find_partners")).toBe(SPAN.findPartners);
    expect(humanSpanName("get_partner_details")).toBe(SPAN.partnerDetails);
    expect(humanSpanName("execute_tool find_partners")).toBe(SPAN.findPartners);
    expect(humanSpanName("execute_tool get_partner_details")).toBe(SPAN.partnerDetails);
  });

  it("falls back readably for an unknown prefixed tool", () => {
    expect(humanSpanName("execute_tool something_else")).toBe("tool:something_else");
  });

  it("types a bare tool span as a TOOL observation", () => {
    expect(langfuseObservationType("find_partners")).toBe("tool");
    expect(langfuseObservationType("get_partner_details")).toBe("tool");
  });

  it("treats bare tool spans as meaningful, so they survive the filter", () => {
    expect(isMeaningfulSpanName("find_partners")).toBe(true);
    expect(isMeaningfulSpanName("get_partner_details")).toBe(true);
  });

  it("never interpolates the model name into a span name (Langfuse groups by it)", () => {
    expect(humanSpanName("chat gpt-4o-mini")).not.toContain("gpt");
    expect(humanSpanName("invoke_agent gpt-4.1")).not.toContain("gpt");
  });

  it("leaves unknown names alone rather than inventing a story", () => {
    expect(humanSpanName("something.unmapped")).toBe("something.unmapped");
  });

  it("gives every named stage a purpose line, so no node needs the source to read", () => {
    for (const name of Object.values(SPAN)) {
      expect(STEP_PURPOSE[name], `missing purpose for ${name}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Filtering — lean traces are the default, and that is a cost decision
// ---------------------------------------------------------------------------

describe("span filtering", () => {
  it("keeps the spans a reader needs", () => {
    for (const name of [
      "workflow.route.flow",
      "ai.eve.turn",
      "invoke_agent gpt-4o-mini",
      "chat gpt-4o-mini",
      "step 1",
      "step 2",
      "execute_tool find_partners",
      SPAN.summary,
      "failure:tool",
    ]) {
      expect(isMeaningfulSpanName(name), `should keep ${name}`).toBe(true);
    }
  });

  it("drops eve's transport and workflow plumbing — the 14x cost multiplier", () => {
    for (const name of [
      "workflow.execute",
      "workflow.stream.read",
      "step.execute",
      "step.hydrate",
      "hook.resume",
      "fetch POST https://example.com",
    ]) {
      expect(isMeaningfulSpanName(name), `should drop ${name}`).toBe(false);
      expect(shouldExportSpan(name, [])).toBe(false);
    }
  });

  it("exports everything when completeness is explicitly requested", () => {
    expect(shouldExportSpan("fetch POST https://example.com", [], true)).toBe(true);
  });

  it("keeps anything we deliberately annotated, as a safety net", () => {
    expect(shouldExportSpan("weird.span", ["app.agent.label"])).toBe(true);
    expect(shouldExportSpan("weird.span", ["langfuse.session.id"])).toBe(true);
  });

  // Regression: eve emits `workflow.route.flow` for EVERY request its runtime
  // handles, including dev-console polling that never starts a turn. The first
  // live run produced 78 such single-span orphan traces against 2 real ones.
  // The processor drops these when the trace has no session; this asserts the
  // rule it keys off is scoped to exactly that span.
  it("marks the request root as turn-scoped, so session-less ones can be dropped", () => {
    expect(isTurnScopedSpanName("workflow.route.flow")).toBe(true);
  });

  it("does NOT mark real work as turn-scoped — those must never be dropped", () => {
    for (const name of ["ai.eve.turn", "chat gpt-4o-mini", "find_partners", "step 1", SPAN.summary]) {
      expect(isTurnScopedSpanName(name), `${name} must not be droppable`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost accuracy — a partner turn makes TWO billed calls
// ---------------------------------------------------------------------------

describe("usage dedupe", () => {
  it("identifies the aggregator span that repeats its children's usage", () => {
    expect(isUsageAggregatorSpan("invoke_agent gpt-4o-mini")).toBe(true);
    expect(isUsageAggregatorSpan("chat gpt-4o-mini")).toBe(false);
  });

  it("recognises the usage attributes Langfuse prices from", () => {
    expect(isUsageAttribute("gen_ai.usage.input_tokens")).toBe(true);
    expect(isUsageAttribute("ai.usage.promptTokens")).toBe(true);
    expect(isUsageAttribute("gen_ai.request.model")).toBe(false);
  });

  it("prices a known model and refuses to invent a price for an unknown one", () => {
    expect(estimateCostUsd("gpt-4o-mini", 1_000_000, 0, 0)).toBeCloseTo(0.15, 6);
    expect(estimateCostUsd("some-unreleased-model", 1_000_000, 1_000_000)).toBe(0);
  });

  it("prices cached input at the cached rate", () => {
    const uncached = estimateCostUsd("gpt-4o-mini", 1_000_000, 0, 0);
    const cached = estimateCostUsd("gpt-4o-mini", 1_000_000, 0, 1_000_000);
    expect(cached).toBeLessThan(uncached);
  });
});

// ---------------------------------------------------------------------------
// Observation typing — mistyping a model call silently loses its cost
// ---------------------------------------------------------------------------

describe("observation typing", () => {
  it("types the turn as an agent and tool calls as tools", () => {
    expect(langfuseObservationType("ai.eve.turn")).toBe("agent");
    expect(langfuseObservationType("execute_tool find_partners")).toBe("tool");
  });

  it("leaves model calls to Langfuse's own gen_ai inference, which drives cost", () => {
    expect(langfuseObservationType("chat gpt-4o-mini")).toBeUndefined();
    expect(langfuseObservationType("invoke_agent gpt-4o-mini")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Retrieval provenance — the question a RAG trace must answer
// ---------------------------------------------------------------------------

/** The legacy pre-R13 single-search shape (kept as a supported fallback). */
const SEARCH_RESULT = {
  needsClarification: false,
  requestedCity: "Bochum",
  recommendations: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }],
  disclosure: "…",
  resolution: {
    homeCount: 12,
    filledCount: 28,
    citiesUsed: ["Bochum", "Essen", "Dortmund"],
    minMet: true,
    cappedAtMax: false,
    citiesExhausted: false,
    allFound: [],
  },
};

/** The R13 batched shape find_partners actually returns today
 *  (agent/tools/find_partners.ts FindPartnersResult). */
const R13_BATCH_RESULT = {
  needsClarification: false,
  batch: { requested: 3, executed: 2, deferred: 1, failed: 0 },
  renderedText: "BATCH RESULT — 2 of 3 search(es) executed, 1 deferred, 0 failed.",
  searches: [
    {
      index: 1,
      cityMention: "bochum",
      intentText: "yoga",
      tags: [],
      status: "ok",
      built: {
        recommendations: [{ name: "A" }, { name: "B" }, { name: "C" }],
        requestedCity: "Bochum",
      },
      resolution: {
        homeCount: 12,
        filledCount: 28,
        citiesUsed: ["Bochum", "Essen", "Dortmund"],
        minMet: true,
        cappedAtMax: false,
        citiesExhausted: false,
        allFound: [],
      },
    },
    {
      index: 2,
      cityMention: "essen",
      intentText: "klettern",
      tags: [],
      status: "ok",
      built: {
        recommendations: [{ name: "D" }, { name: "E" }],
        requestedCity: "Essen",
      },
      resolution: {
        homeCount: 4,
        filledCount: 6,
        citiesUsed: ["Essen", "Bochum"],
        minMet: false,
        cappedAtMax: true,
        citiesExhausted: true,
        allFound: [],
      },
    },
    {
      index: 3,
      cityMention: "hamburg",
      intentText: "schwimmen",
      tags: [],
      status: "deferred_budget",
    },
  ],
};

describe("retrieval provenance", () => {
  it("aggregates the R13 batch shape across executed searches", () => {
    const facts = retrievalFactsFrom(R13_BATCH_RESULT);
    expect(facts).toMatchObject({
      requestedCity: "Bochum + Essen",
      homeCount: 16,
      filledCount: 34,
      citiesUsed: ["Bochum", "Essen", "Dortmund"],
      shown: 5,
      minMet: false, // one executed search fell short
      cappedAtMax: true,
      citiesExhausted: true,
      needsClarification: false,
    });
  });

  it("returns undefined for an R13 batch where nothing executed (all deferred/failed)", () => {
    const facts = retrievalFactsFrom({
      needsClarification: false,
      batch: { requested: 1, executed: 0, deferred: 1, failed: 0 },
      searches: [{ index: 1, cityMention: "x", intentText: "y", tags: [], status: "deferred_budget" }],
      renderedText: "…",
    });
    expect(facts).toBeUndefined();
    expect(retrievalSummary(facts)).toContain("no directory search ran");
  });

  it("treats an R13 all-clarify batch as a clarification outcome", () => {
    const facts = retrievalFactsFrom({
      needsClarification: true,
      question: "Which city?",
      batch: { requested: 1, executed: 0, deferred: 0, failed: 0 },
      searches: [
        { index: 1, cityMention: null, intentText: "yoga", tags: [], status: "clarify_no_city", question: "Which city?" },
      ],
      renderedText: "…",
    });
    expect(facts?.needsClarification).toBe(true);
    expect(retrievalSummary(facts)).toContain("stopped to ask");
  });

  it("reads the search's own accounting out of the full tool output", () => {
    const facts = retrievalFactsFrom(SEARCH_RESULT);
    expect(facts).toMatchObject({
      requestedCity: "Bochum",
      homeCount: 12,
      filledCount: 28,
      citiesUsed: ["Bochum", "Essen", "Dortmund"],
      shown: 5,
      minMet: true,
      needsClarification: false,
    });
  });

  it("records a clarification as a real outcome, not as a failed search", () => {
    const facts = retrievalFactsFrom({ needsClarification: true, question: "Which city?" });
    expect(facts?.needsClarification).toBe(true);
    expect(facts?.shown).toBe(0);
    expect(retrievalSummary(facts)).toContain("stopped to ask");
  });

  it("degrades to undefined on an unexpected shape rather than throwing", () => {
    expect(retrievalFactsFrom(undefined)).toBeUndefined();
    expect(retrievalFactsFrom("a string")).toBeUndefined();
    expect(retrievalFactsFrom({ nothing: true })).toBeUndefined();
    expect(() => retrievalFactsFrom({ resolution: { citiesUsed: "not-an-array" } })).not.toThrow();
  });

  it("summarises home vs borrowed in one readable sentence", () => {
    const summary = retrievalSummary(retrievalFactsFrom(SEARCH_RESULT));
    expect(summary).toContain("Bochum");
    expect(summary).toContain("12 in the home city");
    expect(summary).toContain("28 borrowed");
    expect(summary).toContain("5 shown");
  });

  it("says so plainly when no search ran, instead of implying an empty result", () => {
    expect(retrievalSummary(undefined)).toContain("no directory search ran");
  });

  it("flags a shortfall so it can be charted", () => {
    const summary = retrievalSummary(
      retrievalFactsFrom({
        ...SEARCH_RESULT,
        resolution: { ...SEARCH_RESULT.resolution, minMet: false, citiesExhausted: true },
      }),
    );
    expect(summary).toContain("below the gap-fill minimum");
    expect(summary).toContain("nearby cities exhausted");
  });

  it("never reads partner contact fields, even when the tool output carries them", () => {
    const withPii = {
      ...SEARCH_RESULT,
      recommendations: [{ name: "A", email: "a@example.com", phone: "+49 123" }],
    };
    expect(JSON.stringify(retrievalFactsFrom(withPii))).not.toContain("@example.com");
    expect(JSON.stringify(retrievalFactsFrom(withPii))).not.toContain("+49 123");
  });
});

// ---------------------------------------------------------------------------
// Privacy — content capture is opt-in
// ---------------------------------------------------------------------------

describe("content capture", () => {
  it("is off unless explicitly enabled", () => {
    expect(langfuseRecordIo(env())).toBe(false);
    expect(langfuseRecordIo(env({ LANGFUSE_RECORD_IO: "false" }))).toBe(false);
    expect(langfuseRecordIo(env({ LANGFUSE_RECORD_IO: "true" }))).toBe(true);
  });

  it("gates the full system prompt behind BOTH switches", () => {
    expect(langfuseRecordSystemPrompt(env({ LANGFUSE_RECORD_SYSTEM_PROMPT: "true" }))).toBe(false);
    expect(
      langfuseRecordSystemPrompt(
        env({ LANGFUSE_RECORD_SYSTEM_PROMPT: "true", LANGFUSE_RECORD_IO: "true" }),
      ),
    ).toBe(true);
  });

  it("redacts the visitor's question and the prompt when capture is off", () => {
    const out = generationInput({
      systemPrompt: "=== RULES ===\nbe honest",
      question: "Yoga in Bochum",
      retrieval: retrievalFactsFrom(SEARCH_RESULT),
      recordContent: false,
    });
    expect(out).not.toContain("Yoga in Bochum");
    expect(out).not.toContain("be honest");
    // …but the retrieval accounting is counts and public city names, so it
    // stays: it is what makes a redacted trace still diagnosable.
    expect(out).toContain("Bochum");
    expect(out).toContain("28");
  });

  it("includes the real text when capture is on", () => {
    const out = generationInput({
      systemPrompt: "=== RULES ===\nbe honest",
      question: "Yoga in Bochum",
      recordContent: true,
    });
    expect(out).toContain("Yoga in Bochum");
    expect(out).toContain("be honest");
  });

  it("keeps the wrapper spans free of the full prompt text", () => {
    const out = contextSummary({
      systemPrompt: "=== RULES ===\n" + "x".repeat(50_000),
      question: "Yoga in Bochum",
      retrieval: retrievalFactsFrom(SEARCH_RESULT),
      recordContent: true,
    });
    expect(out).not.toContain("x".repeat(1000));
    expect(out).toContain("digest");
  });

  it("degrades the trace title to a shape rather than leaking text", () => {
    expect(traceTitle("Yoga in Bochum", false, 2)).toBe(
      `${PARTNER_AGENT_LABEL} · Anfrage bearbeitet (2 Schritte)`,
    );
    expect(traceTitle("Yoga in Bochum", true, 2)).toBe(`${PARTNER_AGENT_LABEL} · "Yoga in Bochum"`);
  });

  it("truncates a long question and collapses newlines in the title", () => {
    const title = traceTitle(`${"a".repeat(200)}\n\nmore`, true, 2);
    expect(title.length).toBeLessThan(120);
    expect(title).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// Oversized attributes — the tool result is the biggest thing in the trace
// ---------------------------------------------------------------------------

describe("oversized attributes", () => {
  it("drops the replayed prompt blob", () => {
    expect(isOversizedAttribute("ai.prompt.messages", "x".repeat(MAX_ATTRIBUTE_CHARS + 1))).toBe(
      true,
    );
  });

  it("KEEPS the answer at any size — stripping by size alone emptied outputs", () => {
    expect(isOversizedAttribute("ai.response.text", "x".repeat(MAX_ATTRIBUTE_CHARS + 1))).toBe(
      false,
    );
    expect(isOversizedAttribute("gen_ai.completion", "x".repeat(50_000))).toBe(false);
  });

  it("leaves small attributes and non-strings alone", () => {
    expect(isOversizedAttribute("ai.prompt.messages", "small")).toBe(false);
    expect(isOversizedAttribute("ai.prompt.messages", 12345)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Knowledge fingerprint
// ---------------------------------------------------------------------------

describe("instruction fingerprint", () => {
  it("changes iff the text changes", () => {
    const a = knowledgeSource("=== RULES ===\nbe honest");
    const b = knowledgeSource("=== RULES ===\nbe honest");
    const c = knowledgeSource("=== RULES ===\nbe honest.");
    expect(a?.digest).toBe(b?.digest);
    expect(a?.digest).not.toBe(c?.digest);
  });

  it("lists the section headers actually present", () => {
    expect(knowledgeSource("=== RULES ===\nx\n=== TONE ===\ny")?.sections).toBe("RULES · TONE");
  });

  it("says so rather than guessing when there are no headers", () => {
    expect(knowledgeSource("no headers here")?.sections).toContain("no === SECTION ===");
  });

  it("returns undefined for a missing prompt instead of a fake digest", () => {
    expect(knowledgeSource(undefined)).toBeUndefined();
    expect(knowledgeSource("")).toBeUndefined();
  });

  it("describes this agent as RETRIEVING, unlike the FAQ agent", () => {
    expect(knowledgeSource("=== RULES ===\nx")?.mode).toContain("retrieval");
    expect(knowledgeSource("=== RULES ===\nx")?.source).toContain("Convex");
  });
});

// ---------------------------------------------------------------------------
// Failure stories
// ---------------------------------------------------------------------------

describe("failure spans", () => {
  const base = {
    sessionId: "sess-1",
    agentName: "partner-agent",
    channelKind: "eve",
    env: env(CREDS),
  };

  it("uses a STABLE name and puts the variable message on the status", () => {
    const span = failureSpan({
      ...base,
      kind: "turn",
      subject: "turn_error",
      data: { message: "boom", code: "E1" },
    });
    expect(span.name).toBe("failure:agent-turn");
    expect(span.name).not.toContain("boom");
    expect(span.statusMessage).toBe("[E1] boom");
  });

  it("marks the observation ERROR so Langfuse's error filters find it", () => {
    const span = failureSpan({ ...base, kind: "step", subject: "s", data: { message: "x" } });
    expect(span.attributes[LF.observationLevel]).toBe("ERROR");
  });

  it("classifies a 429 as a SIZE problem for this agent, not a frequency one", () => {
    const span = failureSpan({
      ...base,
      kind: "turn",
      subject: "turn_error",
      data: { message: "429 rate limit exceeded" },
    });
    expect(span.attributes["app.error_type"]).toBe("upstream_unavailable");
    expect(span.attributes["app.error_cause"]).toContain("SIZE");
    expect(span.attributes["app.recommended_action"]).toContain("maxPartners");
  });

  it("explains the unpushed-functions trap when Convex refuses", () => {
    const span = failureSpan({
      ...base,
      kind: "tool",
      subject: "find_partners",
      data: { message: "Could not find public function for 'cities:resolveCityFuzzy'" },
    });
    expect(span.attributes["app.recommended_action"]).toMatch(/convex dev --once/i);
  });

  it("prefers the tool's own error table over the agent-wide one", () => {
    const span = failureSpan({
      ...base,
      kind: "tool",
      subject: "find_partners",
      data: { message: "embedding provider unavailable" },
    });
    expect(span.attributes["app.error_cause"]).toContain("gap-fill");
    expect(span.attributes["app.tool.goal"]).toContain("studios");
  });

  it("still says something useful for an unrecognised error", () => {
    const span = failureSpan({
      ...base,
      kind: "turn",
      subject: "turn_error",
      data: { message: "something nobody has seen before" },
    });
    expect(span.attributes["app.error_type"]).toBe("unexpected");
    expect(span.attributes["app.raw_error"]).toContain("something nobody has seen before");
  });

  it("never leaks the visitor's question when capture is off", () => {
    const span = failureSpan({
      ...base,
      kind: "turn",
      subject: "t",
      data: { message: "x" },
      question: "Yoga in Bochum",
      recordContent: false,
    });
    expect(JSON.stringify(span.attributes)).not.toContain("Yoga in Bochum");
  });

  it("carries a diagnosis as its output, not just a quoted provider error", () => {
    const span = failureSpan({ ...base, kind: "turn", subject: "t", data: { message: "429" } });
    const output = JSON.parse(String(span.attributes[LF.observationOutput]));
    expect(output).toHaveProperty("cause");
    expect(output).toHaveProperty("user_impact");
    expect(output).toHaveProperty("recommended_action");
  });

  it("has a story for each of the two real tools", () => {
    expect(Object.keys(TOOL_STORIES).sort()).toEqual(["find_partners", "get_partner_details"]);
  });
});

// ---------------------------------------------------------------------------
// Turn summary — the trace row a reviewer reads
// ---------------------------------------------------------------------------

describe("turn summary", () => {
  /** The real deployment name matters: cost is looked up from it, and an
   *  unset one must yield 0 rather than an invented price (asserted below). */
  const SEARCH_ENV = env({ ...CREDS, AZURE_AI_CHATBOT_DEPLOYMENT_NAME: "gpt-4o-mini" });

  function journalASearch(recordContent = true, summaryEnv = SEARCH_ENV) {
    const j = new TurnJournal();
    j.record("s1", "message.received", { message: "Yoga in Bochum" }, 1_000);
    j.record("s1", "step.completed", { usage: { inputTokens: 900, outputTokens: 40 } }, 1_100);
    j.record(
      "s1",
      "action.result",
      { result: { toolName: "find_partners", isError: false, output: SEARCH_RESULT } },
      1_200,
    );
    j.record("s1", "message.appended", {}, 1_300);
    j.record("s1", "step.completed", { usage: { inputTokens: 8_000, outputTokens: 400 } }, 1_400);
    j.record("s1", "message.completed", { text: "Hier sind 5 Partner in Bochum …" }, 1_500);
    return j.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "partner-agent",
      channelKind: "eve",
      recordContent,
      now: 2_000,
      systemPrompt: "=== RULES ===\nbe honest",
      env: summaryEnv,
    });
  }

  it("records the retrieval provenance on the TRACE, so the list is scannable", () => {
    const s = journalASearch();
    const md = (k: string) => s?.attributes[`${LF.traceMetadataPrefix}${k}`];
    expect(md("retrieval.city")).toBe("Bochum");
    expect(md("retrieval.home_count")).toBe("12");
    expect(md("retrieval.filled_count")).toBe("28");
    expect(md("retrieval.shown")).toBe("5");
    expect(md("retrieval.cities_used")).toBe("Bochum, Essen, Dortmund");
    expect(String(md("knowledge.retrieved"))).toContain("borrowed");
  });

  it("counts the model steps — 4 would mean the old tool chain regressed", () => {
    const s = journalASearch();
    expect(s?.attributes[`${LF.traceMetadataPrefix}steps.model_calls`]).toBe("2");
    expect(s?.attributes[`${LF.traceMetadataPrefix}steps.expected`]).toContain("2 (search turn)");
  });

  it("sums tokens across BOTH billed calls and estimates cost", () => {
    const s = journalASearch();
    const md = (k: string) => s?.attributes[`${LF.traceMetadataPrefix}${k}`];
    expect(md("tokens.input")).toBe("8900");
    expect(md("tokens.output")).toBe("440");
    expect(md("tokens.total")).toBe("9340");
    expect(md("model")).toBe("gpt-4o-mini");
    expect(Number(md("cost.estimate_usd"))).toBeGreaterThan(0);
  });

  it("reports 0 cost for an unknown deployment rather than inventing a price", () => {
    const s = journalASearch(true, env(CREDS)); // no AZURE_..._DEPLOYMENT_NAME
    expect(s?.attributes[`${LF.traceMetadataPrefix}model`]).toBe("unknown");
    expect(s?.attributes[`${LF.traceMetadataPrefix}cost.estimate_usd`]).toBe("0.000000");
  });

  it("records time-to-first-token, this agent's most visible UX number", () => {
    const s = journalASearch();
    expect(s?.attributes[`${LF.traceMetadataPrefix}timing.first_token_ms`]).toBe("300");
    expect(s?.attributes[`${LF.traceMetadataPrefix}timing.duration_ms`]).toBe("1000");
  });

  it("says 'not observed' rather than 0 when no token was streamed", () => {
    const j = new TurnJournal();
    j.record("s2", "message.received", { message: "hi" }, 1_000);
    j.record("s2", "step.completed", { usage: {} }, 1_100);
    const s = j.finalize({
      sessionId: "s2",
      outcome: "answered",
      agentName: "a",
      recordContent: true,
      now: 1_200,
      env: env(CREDS),
    });
    expect(s?.attributes[`${LF.traceMetadataPrefix}timing.first_token_ms`]).toBe("not observed");
  });

  it("tags a gap-filled search so it can be filtered", () => {
    const tags = journalASearch()?.attributes[LF.traceTags] as string[];
    expect(tags).toContain("partner-agent");
    expect(tags).toContain("searched");
    expect(tags).toContain("gap-filled");
  });

  it("distinguishes a no-search turn from a search turn", () => {
    const j = new TurnJournal();
    j.record("s3", "message.received", { message: "Hallo" }, 1_000);
    j.record("s3", "step.completed", { usage: { inputTokens: 500, outputTokens: 20 } }, 1_100);
    j.record("s3", "message.completed", { text: "Hi!" }, 1_200);
    const s = j.finalize({
      sessionId: "s3",
      outcome: "answered",
      agentName: "a",
      recordContent: true,
      now: 1_300,
      env: env(CREDS),
    });
    const tags = s?.attributes[LF.traceTags] as string[];
    expect(tags).toContain("no-search");
    expect(s?.attributes[`${LF.traceMetadataPrefix}retrieval.searched`]).toBe("no");
    expect(String(s?.attributes[`${LF.traceMetadataPrefix}knowledge.retrieved`])).toContain(
      "no directory search ran",
    );
  });

  it("does not call a turn that ASKED a question 'answered'", () => {
    const j = new TurnJournal();
    j.record("s4", "message.received", { message: "yoga" }, 1_000);
    j.record("s4", "step.completed", { usage: {} }, 1_100);
    j.record("s4", "input.requested", { question: "In welcher Stadt?" }, 1_200);
    const s = j.finalize({
      sessionId: "s4",
      outcome: "answered",
      agentName: "a",
      recordContent: true,
      now: 1_300,
      env: env(CREDS),
    });
    expect(s?.attributes[`${LF.traceMetadataPrefix}outcome`]).toBe("asked-for-clarification");
    expect(s?.attributes[LF.traceOutput]).toBe("In welcher Stadt?");
  });

  it("returns nothing rather than a misleading empty span", () => {
    const j = new TurnJournal();
    expect(
      j.finalize({
        sessionId: "never-seen",
        outcome: "answered",
        agentName: "a",
        recordContent: true,
        now: 1,
        env: env(CREDS),
      }),
    ).toBeUndefined();
  });

  it("redacts both sides of the conversation when capture is off", () => {
    const s = journalASearch(false);
    expect(String(s?.attributes[LF.traceInput])).toContain("content capture off");
    expect(String(s?.attributes[LF.traceOutput])).toContain("content capture off");
    expect(JSON.stringify(s?.attributes)).not.toContain("Yoga in Bochum");
  });

  it("identifies the agent so a trace is readable without knowing the repo", () => {
    const s = journalASearch();
    expect(s?.attributes[`${LF.traceMetadataPrefix}agent`]).toBe(PARTNER_AGENT_LABEL);
    expect(String(s?.attributes[`${LF.traceMetadataPrefix}agent.role`])).toContain("never invents");
  });

  it("does not duplicate trace metadata as app.* on the observation", () => {
    const s = journalASearch();
    const appKeys = Object.keys(s?.attributes ?? {}).filter((k) => k.startsWith("app."));
    expect(appKeys).not.toContain("app.model");
    expect(appKeys).not.toContain("app.outcome");
  });

  it("puts the session id on the summary so Sessions groups it", () => {
    expect(journalASearch()?.attributes[LF.sessionId]).toBe("s1");
  });
});

// ---------------------------------------------------------------------------
// The hook — never throws, and bridges retrieval to the span processor
// ---------------------------------------------------------------------------

describe("hook", () => {
  function recorder() {
    const spans: EmittedSpan[] = [];
    const emitter: SpanEmitter = { emit: (s) => spans.push(s) };
    return { spans, emitter };
  }
  const ctx = { agent: { name: "partner-agent" }, channel: { kind: "eve" }, session: { id: "h1" } };

  it("emits one summary span per completed turn", async () => {
    const { spans, emitter } = recorder();
    const h = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 5_000 });
    await h["message.received"]({ data: { message: "Yoga in Bochum" } }, ctx);
    await h["step.completed"]({ data: { usage: { inputTokens: 10, outputTokens: 2 } } }, ctx);
    await h["message.completed"]({ data: { text: "Hier sind …" } }, ctx);
    await h["turn.completed"]({}, ctx);
    expect(spans.filter((s) => s.name === SPAN.summary)).toHaveLength(1);
  });

  it("emits an ERROR span for a failed tool call", async () => {
    const { spans, emitter } = recorder();
    const h = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 5_000 });
    await h["action.result"](
      { data: { result: { toolName: "find_partners", isError: true, output: "convex down" } } },
      ctx,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("failure:tool");
    expect(spans[0].error).toContain("convex down");
  });

  it("stays silent on a SUCCESSFUL tool call — it is already on the trace", async () => {
    const { spans, emitter } = recorder();
    const h = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 5_000 });
    await h["action.result"](
      { data: { result: { toolName: "find_partners", isError: false, output: SEARCH_RESULT } } },
      ctx,
    );
    expect(spans).toHaveLength(0);
  });

  it("never throws, whatever the event payload is", async () => {
    const { emitter } = recorder();
    const h = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 1 });
    for (const name of Object.keys(h)) {
      await expect(h[name]({ data: undefined }, ctx)).resolves.toBeUndefined();
      await expect(h[name]({}, ctx)).resolves.toBeUndefined();
      await expect(
        h[name]({ data: { result: null, message: 42 } as never }, ctx),
      ).resolves.toBeUndefined();
    }
  });

  it("does not subscribe to turn.cancelled — a cancel is not a failure", () => {
    const { emitter } = recorder();
    expect(Object.keys(handlersFor(emitter))).not.toContain("turn.cancelled");
  });

  it("emits a summary even when the turn FAILED, so the trace has a row", async () => {
    const { spans, emitter } = recorder();
    const h = handlersFor(emitter, new TurnJournal(), { recordContent: true, now: () => 5_000 });
    await h["message.received"]({ data: { message: "Yoga in Bochum" } }, ctx);
    await h["turn.failed"]({ data: { code: "E", message: "boom" } }, ctx);
    expect(spans.map((s) => s.name)).toEqual(["failure:agent-turn", SPAN.summary]);
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe("metadata helpers", () => {
  it("prefixes trace metadata so it lands on the TRACE, not just an observation", () => {
    expect(traceMetadata({ outcome: "answered" })).toEqual({
      "langfuse.trace.metadata.outcome": "answered",
    });
  });

  it("reports the deployment and a dev fallback for the version", () => {
    const m = appMetadata(env({ AZURE_AI_CHATBOT_DEPLOYMENT_NAME: "gpt-4o-mini" }));
    expect(m["app.model"]).toBe("gpt-4o-mini");
    expect(m["app.version"]).toBe("dev");
  });
});
