// Langfuse invariants for the ORCHESTRATOR, offline.
//
// Most of these encode something a LIVE trace disproved. The event shapes below
// are copied verbatim from a wildcard-hook dump of a real delegated turn
// (2026-08-18) rather than from the docs, because every wrong guess in this
// integration looked green until the trace was read back.
import { describe, expect, it } from "vitest";

import {
  LF,
  ORCHESTRATOR_LABEL,
  PARTNER_LINK,
  ROUTES,
  SPAN,
  STEP_PURPOSE,
  TurnJournal,
  contextSummary,
  estimateCostUsd,
  failureSpan,
  generationInput,
  humanSpanName,
  isMeaningfulSpanName,
  isTurnScopedSpanName,
  knowledgeSource,
  langfuseAuthHeader,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  langfuseObservationType,
  langfuseRecordIo,
  langfuseTracesUrl,
  routeForTool,
  shouldExportSpan,
  toolNamesFrom,
  traceTitle,
} from "../lib/langfuse.ts";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

const CREDS = {
  LANGFUSE_BASE_URL: "https://sportnavi-langfuse.sportnavi.de",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
};

// Verbatim from a live delegated turn.
const ACTIONS_REQUESTED = {
  actions: [
    {
      callId: "call_oH8h935aVZodETicFs23O9AA",
      description: "Beantwortet Fragen zu Sportnavi selbst …",
      input: { message: "Der Nutzer hat gefragt, was der 4-Sterne-Tarif kostet." },
      kind: "subagent-call",
      name: "faq",
      nodeId: "subagents/faq",
      subagentName: "faq",
    },
  ],
  sequence: 0,
  stepIndex: 0,
  turnId: "turn_0",
};

const SUBAGENT_RESULT = {
  result: {
    callId: "call_oH8h935aVZodETicFs23O9AA",
    kind: "subagent-result",
    output: "Der 4-Sterne-Tarif kostet 59,90 € brutto pro Monat.",
    subagentName: "faq", // NOTE: not `toolName`
    usage: { cacheReadTokens: 17664, inputTokens: 17761, outputTokens: 69 },
  },
  sequence: 0,
  stepIndex: 0,
  status: "completed",
  turnId: "turn_0",
};

describe("enablement and transport", () => {
  it("is a complete no-op without credentials", () => {
    expect(langfuseEnabled(env())).toBe(false);
    expect(langfuseEnabled(env(CREDS))).toBe(true);
  });

  it("posts to the OTLP traces path with Basic auth and the v4 header", () => {
    expect(langfuseTracesUrl(env(CREDS))).toBe(
      "https://sportnavi-langfuse.sportnavi.de/api/public/otel/v1/traces",
    );
    expect(langfuseAuthHeader(env(CREDS))).toBe(
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test", "utf8").toString("base64")}`,
    );
    expect(langfuseHeaders(env(CREDS))["x-langfuse-ingestion-version"]).toBe("4");
  });

  it("normalises the environment tag Langfuse would otherwise reject", () => {
    expect(langfuseEnvironment(env({ LANGFUSE_TRACING_ENVIRONMENT: "langfuse-x" }))).toBe(
      "development",
    );
    expect(langfuseEnvironment(env({ LANGFUSE_TRACING_ENVIRONMENT: "Pre Prod!" }))).toBe("pre-prod-");
  });
});

describe("span naming", () => {
  it("renames the orchestration flow to what happened", () => {
    expect(humanSpanName("workflow.route.flow")).toBe(SPAN.request);
    expect(humanSpanName("ai.eve.turn")).toBe(SPAN.turn);
    expect(humanSpanName("invoke_agent gpt-4o-mini")).toBe(SPAN.orchestrate);
    expect(humanSpanName("chat gpt-4o-mini")).toBe(SPAN.generate);
  });

  it("gives every AI-SDK step ONE stable name — numbering restarts per pass", () => {
    expect(humanSpanName("step 1")).toBe(SPAN.step);
    expect(humanSpanName("step 2")).toBe(SPAN.step);
  });

  it("names each capability, bare or prefixed", () => {
    expect(humanSpanName("faq")).toBe(SPAN.delegateFaq);
    expect(humanSpanName("execute_tool find_partners")).toBe(SPAN.findPartners);
    expect(humanSpanName("request_human_contact")).toBe(SPAN.humanContact);
    expect(humanSpanName("ask_question")).toBe(SPAN.askQuestion);
    expect(humanSpanName("provide_booking_link")).toBe(SPAN.provideBookingLink);
  });

  it("never interpolates the model into a span name", () => {
    expect(humanSpanName("chat gpt-4o-mini")).not.toContain("gpt");
  });

  it("gives every named stage a purpose line", () => {
    for (const name of Object.values(SPAN)) {
      expect(STEP_PURPOSE[name], `missing purpose for ${name}`).toBeTruthy();
    }
  });

  it("types delegations as TOOL and the turn as AGENT, leaving model calls to inference", () => {
    expect(langfuseObservationType("ai.eve.turn")).toBe("agent");
    expect(langfuseObservationType("faq")).toBe("tool");
    expect(langfuseObservationType("chat gpt-4o-mini")).toBeUndefined();
  });
});

describe("span filtering", () => {
  it("keeps meaningful spans and drops eve's plumbing", () => {
    for (const n of ["workflow.route.flow", "ai.eve.turn", "step 1", "faq", SPAN.summary]) {
      expect(isMeaningfulSpanName(n), n).toBe(true);
    }
    for (const n of ["workflow.execute", "step.execute", "fetch POST https://x"]) {
      expect(shouldExportSpan(n, []), n).toBe(false);
    }
  });

  it("marks only the request root as turn-scoped", () => {
    expect(isTurnScopedSpanName("workflow.route.flow")).toBe(true);
    expect(isTurnScopedSpanName("ai.eve.turn")).toBe(false);
  });
});

describe("routing", () => {
  it("maps every capability to a route, and refuses to guess for unknown ones", () => {
    expect(routeForTool("faq")).toBe("faq");
    expect(routeForTool("find_partners")).toBe("find_partners");
    expect(routeForTool("request_human_contact")).toBe("request_human_contact");
    expect(routeForTool("provide_booking_link")).toBe("provide_booking_link");
    expect(routeForTool("something_new")).toBeUndefined();
  });

  it("says WHERE each route's work is traced — the multi-project answer", () => {
    expect(ROUTES.faq.tracedIn).toBe("this trace");
    expect(ROUTES.find_partners.tracedIn).toContain(PARTNER_LINK.project);
  });

  it("traces the booking route inside this project, not a separate service", () => {
    // Unlike find_partners (service 2) or faq (a local subagent with its own
    // child session), provide_booking_link is a static config lookup with no
    // delegation at all — its work is entirely within this trace.
    expect(ROUTES.provide_booking_link.tracedIn).toBe("this trace");
    expect(ROUTES.provide_booking_link.handler).not.toMatch(/subagent|HTTP|service 2/i);
  });

  // Regression: the real payload nests tool names inside `actions[]`.
  it("finds the chosen capability inside a real actions.requested payload", () => {
    expect(toolNamesFrom(ACTIONS_REQUESTED)).toContain("faq");
  });

  it("degrades to an empty list rather than throwing on an unexpected shape", () => {
    expect(toolNamesFrom(undefined)).toEqual([]);
    expect(toolNamesFrom({ deeply: { nested: null } })).toEqual([]);
    expect(() => toolNamesFrom({ a: { b: { c: { d: { e: { f: {} } } } } } })).not.toThrow();
  });

  it("puts the agent AND the route in the trace title", () => {
    expect(traceTitle("Yoga in Bochum", true, "find_partners")).toBe(
      `${ORCHESTRATOR_LABEL} → find_partners · "Yoga in Bochum"`,
    );
    expect(traceTitle("Yoga in Bochum", false, "faq")).not.toContain("Yoga");
  });
});

describe("turn summary", () => {
  const SUMMARY_ENV = env({ ...CREDS, AZURE_ROUTER_DEPLOYMENT_NAME: "gpt-4o-mini" });

  function delegatedTurn() {
    const j = new TurnJournal();
    j.record("s1", "message.received", { message: "Was kostet der 4-Sterne-Tarif?" }, 1_000);
    j.record("s1", "actions.requested", ACTIONS_REQUESTED, 1_500);
    j.record("s1", "step.completed", { usage: { inputTokens: 900, outputTokens: 30 } }, 1_600);
    j.record("s1", "subagent.completed", { subagentName: "faq", output: "…" }, 3_000);
    j.record("s1", "action.result", SUBAGENT_RESULT, 3_100);
    j.record("s1", "message.appended", {}, 3_200);
    j.record("s1", "step.completed", { usage: { inputTokens: 1200, outputTokens: 80 } }, 3_400);
    j.record("s1", "message.completed", { text: "59,90 € brutto pro Monat." }, 3_500);
    return j.finalize({
      sessionId: "s1",
      outcome: "answered",
      agentName: "navio-orchestrator",
      channelKind: "eve",
      recordContent: true,
      now: 4_000,
      systemPrompt: "=== IDENTITÄT ===\nDu bist Navio",
      env: SUMMARY_ENV,
    });
  }

  const md = (s: ReturnType<TurnJournal["finalize"]>, k: string) =>
    s?.attributes[`${LF.traceMetadataPrefix}${k}`];

  it("records WHICH specialist was chosen and who handles it", () => {
    const s = delegatedTurn();
    expect(md(s, "routing.selected")).toBe("faq");
    expect(String(md(s, "routing.handled_by"))).toContain("subagent");
    expect(md(s, "delegation.calls")).toContain("faq");
  });

  it("measures how long the routing DECISION took, separate from the turn", () => {
    const s = delegatedTurn();
    expect(md(s, "routing.decision_ms")).toBe("500");
    expect(md(s, "timing.duration_ms")).toBe("3000");
  });

  // Regression: the delegation result is keyed `subagentName`, not `toolName`.
  // Reading only `toolName` left every delegation field empty on a live run.
  it("reads a delegation named `subagentName`, not just `toolName`", () => {
    expect(md(delegatedTurn(), "delegation.calls")).toBe("faq");
  });

  // Regression: the child runs in its own session, so its step events never
  // reach this journal. Its usage arrives ONLY on the delegation result.
  it("captures the SPECIALIST's tokens, which the router's own steps never see", () => {
    const s = delegatedTurn();
    expect(md(s, "delegation.tokens_input")).toBe("17761");
    expect(md(s, "delegation.tokens_output")).toBe("69");
    // …and keeps them OUT of the router's own totals, so neither double-counts.
    expect(md(s, "tokens.input")).toBe("2100");
  });

  it("treats a turn with no delegation as a real route, not a missing value", () => {
    const j = new TurnJournal();
    j.record("s2", "message.received", { message: "Hallo" }, 1_000);
    j.record("s2", "step.completed", { usage: { inputTokens: 400, outputTokens: 10 } }, 1_100);
    j.record("s2", "message.completed", { text: "Hi!" }, 1_200);
    const s = j.finalize({
      sessionId: "s2",
      outcome: "answered",
      agentName: "navio-orchestrator",
      recordContent: true,
      now: 1_300,
      env: SUMMARY_ENV,
    });
    expect(md(s, "routing.selected")).toBe("direct_reply");
    expect(md(s, "routing.delegated")).toBe("no");
    expect(s?.attributes[LF.traceTags]).toContain("route:direct_reply");
  });

  it("does not call a turn that ASKED a question 'answered'", () => {
    const j = new TurnJournal();
    j.record("s3", "message.received", { message: "yoga" }, 1_000);
    j.record("s3", "step.completed", { usage: {} }, 1_100);
    j.record("s3", "input.requested", { question: "In welcher Stadt?" }, 1_200);
    const s = j.finalize({
      sessionId: "s3",
      outcome: "answered",
      agentName: "a",
      recordContent: true,
      now: 1_300,
      env: SUMMARY_ENV,
    });
    expect(md(s, "outcome")).toBe("asked-for-clarification");
    expect(md(s, "routing.selected")).toBe("ask_question");
  });

  it("records the cross-project link for a partner delegation", () => {
    const j = new TurnJournal();
    j.record("s4", "message.received", { message: "Yoga in Bochum" }, 1_000);
    j.record("s4", "actions.requested", { actions: [{ name: "find_partners" }] }, 1_200);
    j.record(
      "s4",
      "action.result",
      {
        result: {
          toolName: "find_partners",
          output: { ok: true, searchPerformed: true, partnerSessionId: "wrun_partner_123" },
        },
        status: "completed",
      },
      2_000,
    );
    j.record("s4", "step.completed", { usage: { inputTokens: 100, outputTokens: 10 } }, 2_100);
    j.record("s4", "message.completed", { text: "Hier sind …" }, 2_200);
    const s = j.finalize({
      sessionId: "s4",
      outcome: "answered",
      agentName: "a",
      recordContent: true,
      now: 2_300,
      env: SUMMARY_ENV,
    });
    expect(md(s, "partner.session_id")).toBe("wrun_partner_123");
    expect(String(md(s, "partner.project"))).toContain("Partner");
    expect(md(s, "partner.search_performed")).toBe("true");
    expect(s?.attributes[LF.traceTags]).toContain("cross-service:partner");
  });

  it("flags a partner answer produced WITHOUT a database query", () => {
    const j = new TurnJournal();
    j.record("s5", "message.received", { message: "Yoga in Bochum" }, 1_000);
    j.record(
      "s5",
      "action.result",
      { result: { toolName: "find_partners", output: { ok: true, searchPerformed: false } } },
      2_000,
    );
    j.record("s5", "step.completed", { usage: {} }, 2_100);
    const s = j.finalize({
      sessionId: "s5",
      outcome: "answered",
      agentName: "a",
      recordContent: true,
      now: 2_200,
      env: SUMMARY_ENV,
    });
    expect(s?.attributes[LF.traceTags]).toContain("partner-answered-without-search");
  });

  it("redacts both sides when content capture is off", () => {
    const j = new TurnJournal();
    j.record("s6", "message.received", { message: "geheim" }, 1_000);
    j.record("s6", "step.completed", { usage: {} }, 1_100);
    j.record("s6", "message.completed", { text: "antwort" }, 1_200);
    const s = j.finalize({
      sessionId: "s6",
      outcome: "answered",
      agentName: "a",
      recordContent: false,
      now: 1_300,
      env: SUMMARY_ENV,
    });
    expect(JSON.stringify(s?.attributes)).not.toContain("geheim");
    expect(JSON.stringify(s?.attributes)).not.toContain("antwort");
  });

  it("returns nothing rather than a misleading empty span", () => {
    expect(
      new TurnJournal().finalize({
        sessionId: "never",
        outcome: "answered",
        agentName: "a",
        recordContent: true,
        now: 1,
        env: SUMMARY_ENV,
      }),
    ).toBeUndefined();
  });
});

describe("failures", () => {
  const base = { sessionId: "s", agentName: "navio-orchestrator", env: env(CREDS) };

  it("uses a stable name and names the route that failed", () => {
    const span = failureSpan({
      ...base,
      kind: "tool",
      subject: "find_partners",
      route: "find_partners",
      data: { message: "Partner service unreachable: fetch failed" },
    });
    expect(span.name).toBe("failure:delegation");
    expect(span.attributes[LF.observationLevel]).toBe("ERROR");
    expect(span.attributes["app.failure.route"]).toBe("find_partners");
  });

  it("explains the wrong-port trap rather than only quoting the error", () => {
    const span = failureSpan({
      ...base,
      kind: "tool",
      subject: "find_partners",
      data: { message: "Partner service returned HTTP 404." },
    });
    expect(String(span.attributes["app.recommended_action"])).toMatch(/port|PARTNER_AGENT_HOST/i);
  });

  it("still says something useful for an unrecognised error", () => {
    const span = failureSpan({ ...base, kind: "turn", subject: "t", data: { message: "???" } });
    expect(span.attributes["app.error_type"]).toBe("unexpected");
  });

  it("never leaks the question when capture is off", () => {
    const span = failureSpan({
      ...base,
      kind: "turn",
      subject: "t",
      data: { message: "x" },
      question: "geheim",
      recordContent: false,
    });
    expect(JSON.stringify(span.attributes)).not.toContain("geheim");
  });
});

describe("context rendering", () => {
  it("shows the model the routing options it chose between", () => {
    const out = generationInput({
      systemPrompt: "=== IDENTITÄT ===\nx",
      question: "Yoga in Bochum",
      route: "find_partners",
      recordContent: true,
    });
    expect(out).toContain("find_partners");
    expect(out).toContain("faq");
  });

  it("keeps the full prompt off wrapper spans but keeps the fingerprint", () => {
    const out = contextSummary({
      systemPrompt: `=== IDENTITÄT ===\n${"x".repeat(50_000)}`,
      question: "hi",
      route: "faq",
      recordContent: true,
    });
    expect(out).not.toContain("x".repeat(1000));
    expect(out).toContain("digest");
  });

  it("describes the orchestrator as holding no product knowledge", () => {
    expect(knowledgeSource("=== IDENTITÄT ===\nx")?.mode).toContain("routing prompt only");
  });

  it("prices a known model and refuses to invent one otherwise", () => {
    expect(estimateCostUsd("gpt-4o-mini", 1_000_000, 0, 0)).toBeCloseTo(0.15, 6);
    expect(estimateCostUsd("mystery-model", 1_000_000, 1_000_000)).toBe(0);
  });

  it("keeps content capture opt-in", () => {
    expect(langfuseRecordIo(env())).toBe(false);
    expect(langfuseRecordIo(env({ LANGFUSE_RECORD_IO: "true" }))).toBe(true);
  });
});
