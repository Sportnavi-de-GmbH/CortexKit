/**
 * PROCESS: the eve agent process (booted by `eve dev` / withEve()), NOT
 * Next.js, NOT the browser. `withEve()` runs eve as a separate process, so a
 * `Sentry.init()` (or any OTel provider registration) anywhere in the
 * Next.js layer would not instrument the agent — this file is the only
 * place agent observability can be configured (node_modules/eve/docs/guides/
 * instrumentation.md). This file existing is also what makes eve enable AI
 * SDK telemetry at all — delete it and the agent goes dark.
 *
 * Two observability backends share this one file: Sentry (error/perf
 * monitoring, pre-existing) and LangSmith (agent trace trees + cost, added
 * per EVE_LANGSMITH_TRACING_GUIDE.md).
 *
 * WHY THEY SHARE ONE OTEL PROVIDER, NOT TWO: `@opentelemetry/api`'s global
 * tracer provider is a process-wide singleton — the first call to register
 * one wins and every later call is silently ignored. `Sentry.init()` already
 * registers one (that's how `vercelAIIntegration` sees eve's AI SDK spans).
 * The tracing guide's own reference implementation calls `@vercel/otel`'s
 * `registerOTel()` to create a *second* provider — fine in a Sentry-free
 * project, but here that second registration would just be dropped, and
 * LangSmith would receive nothing while looking perfectly wired. Instead,
 * `Sentry.init({ openTelemetrySpanProcessors })` (a documented @sentry/node
 * option, node_modules/@sentry/node-core/build/types/types.d.ts) attaches an
 * ADDITIONAL span processor onto Sentry's own provider — both backends read
 * the same span stream, each running its own filter/export pipeline. This is
 * the fix for the guide's "don't stack vendor AI integrations" warning: we
 * are not stacking a second AI SDK integration, only a second *exporter* on
 * the one already-registered provider.
 *
 * The LangSmith trace pipe (spans, Part A) and the LangSmith hook
 * (agent/hooks/langsmith.ts — failures + turn summary, Part B) are
 * independent, same as the pre-existing Sentry pipe/hook pair: eve reports
 * failures as stream events, never exceptions, so trace export alone would
 * capture zero failures.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Context } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Sentry from "@sentry/node";
import { defineInstrumentation } from "eve/instrumentation";

import {
  LANGSMITH_EU_OTEL_TRACES_URL,
  SpanFilterState,
  dottedStampFromHr,
  humanSpanName,
  langsmithEnabled,
  projectName as langsmithProjectName,
  otelRunId,
  recordIo as langsmithRecordIo,
  shouldExportSpan,
  systemPromptStore,
  traceAnchors,
} from "../lib/langsmith";
import { scrub } from "../lib/sentry-agent";

// PRIVACY DEFAULT: recording inputs/outputs ships user text and partner data
// off-box, which lib/observability.ts forbids for log sinks. Strict opt-in.
//
// `recordInputs`/`recordOutputs` are a single eve-wide switch that governs the
// AI SDK spans BOTH backends read — so either backend's opt-in has to turn it
// on. Gating it on SENTRY_RECORD_IO alone (as it was) meant that with only
// LANGSMITH_RECORD_IO=true set — the actual configuration of this agent —
// every llm run in LangSmith arrived with `inputs: {}` and no completion text,
// and every tool run with no arguments or result. The system prompt still
// showed up (it travels the separate file-store path, §8.1), which is what
// made the gap look like "LangSmith drops messages" rather than "eve was told
// not to record them".
const LANGSMITH_RECORD_IO = langsmithRecordIo();
const RECORD_IO = process.env.SENTRY_RECORD_IO === "true" || LANGSMITH_RECORD_IO;

/** OTel JS 2.x moved the parent id from `parentSpanId` to
 *  `parentSpanContext.spanId` (verified against the installed
 *  @opentelemetry/sdk-trace 2.x in this repo). */
function parentIdOf(span: Span | ReadableSpan): string | undefined {
  const s = span as { parentSpanId?: string; parentSpanContext?: { spanId?: string } };
  return s.parentSpanId ?? s.parentSpanContext?.spanId;
}

function withHumanName(span: ReadableSpan): ReadableSpan {
  const name = humanSpanName(span.name);
  if (name === span.name) return span;
  // Only the NAME is overridden — every other field (attributes, ids,
  // timing) forwards untouched, because run typing/tokens/tree-stitching in
  // LangSmith key off attributes, never names (EVE_LANGSMITH_TRACING_GUIDE.md §9.2).
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "name") return name;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * Filters eve's Workflow-SDK infrastructure noise out of the LangSmith
 * export while keeping every ancestor of every AI span — LangSmith
 * reconstructs trace trees from parent links and silently drops any span
 * whose parent never arrives (EVE_LANGSMITH_TRACING_GUIDE.md §5 Step A3).
 * Filtering is therefore a TREE decision, never a per-span one.
 */
class LangsmithAiSpanFilter implements SpanProcessor {
  private readonly state = new SpanFilterState();
  /** Spans currently open, so the anchor walk can find the trace ROOT while
   *  the turn is still running. Entries are removed as spans end. */
  private readonly open = new Map<string, { parent?: string; sec: number; nanos: number }>();
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const spanId = span.spanContext().spanId;
    const parent = parentIdOf(span);
    this.state.onStart(spanId, parent);

    const [sec, nanos] = span.startTime;
    this.open.set(spanId, { parent, sec, nanos });
    this.publishAnchor(span, spanId);

    this.inner.onStart(span, parentContext);
  }

  /**
   * Part C (EVE_LANGSMITH_TRACING_GUIDE.md §7): when the turn span starts,
   * compute the run id LangSmith WILL assign to this trace's root span and
   * hand it to the hook through a file. The hook then pre-creates that run as
   * the turn summary, so the request's conversation IO and its OTLP token/cost
   * subtree end up in ONE trace instead of two disconnected ones.
   */
  private publishAnchor(span: Span, spanId: string): void {
    // eve 0.25.x emits `eve.turn`; the guide documents `ai.eve.turn`. Accept both.
    if (span.name !== "eve.turn" && span.name !== "ai.eve.turn") return;
    try {
      const sessionId = span.attributes["eve.session.id"];
      if (typeof sessionId !== "string" || sessionId === "") return;

      // Walk to the highest ancestor still open — that is the span LangSmith
      // will turn into this trace's root run.
      let rootId = spanId;
      for (let guard = 0; guard < 100; guard += 1) {
        const entry = this.open.get(rootId);
        if (!entry?.parent || !this.open.has(entry.parent)) break;
        rootId = entry.parent;
      }
      const root = this.open.get(rootId);
      if (!root) return;

      const runId = otelRunId(rootId);
      traceAnchors.set(sessionId, {
        rootRunId: runId,
        rootDotted: `${dottedStampFromHr(root.sec, root.nanos)}${runId}`,
        rootStartMs: root.sec * 1000 + Math.floor(root.nanos / 1e6),
      });
    } catch {
      // Observability must never break the agent — a missing anchor only
      // degrades to the old two-trace shape.
    }
  }

  onEnd(span: ReadableSpan): void {
    this.open.delete(span.spanContext().spanId);
    const ai = shouldExportSpan(span.name, Object.keys(span.attributes));
    const keep =
      process.env.LANGSMITH_EXPORT_ALL === "true" ||
      this.state.onEnd(span.spanContext().spanId, parentIdOf(span), ai);

    // Local span-debug log: separates "our exporter never saw it" from
    // "LangSmith hasn't ingested it yet" — the two failure modes that look
    // identical from the UI (OTLP returns 200 before processing).
    const spanDebug = process.env.EVE_LS_SPAN_DEBUG;
    if (spanDebug === "1" || spanDebug === "2") {
      try {
        const logPath = process.env.EVE_LS_SPAN_LOG ?? ".data/langsmith-spans.log";
        mkdirSync(dirname(logPath), { recursive: true });
        // Level 2 adds attribute keys — the only way to confirm which spans
        // actually carry `eve.session.id` (the anchor key) and the `gen_ai.*`
        // attributes LangSmith needs to compute cost.
        const attrs = spanDebug === "2" ? ` | ${Object.keys(span.attributes).join(",")}` : "";
        appendFileSync(logPath, `${keep ? "KEEP" : "DROP"}${ai ? " ai" : ""} | ${span.name}${attrs}\n`);
      } catch {
        // Diagnostics must never break the agent.
      }
    }

    if (keep) this.inner.onEnd(withHumanName(span));
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function langsmithSpanProcessors(agentName: string): SpanProcessor[] {
  if (!langsmithEnabled()) return []; // no key = no exporter, never an error

  return [
    new LangsmithAiSpanFilter(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: LANGSMITH_EU_OTEL_TRACES_URL,
          headers: {
            "x-api-key": process.env.LANGSMITH_API_KEY ?? "",
            "Langsmith-Project": langsmithProjectName(process.env, agentName),
          },
        }),
      ),
    ),
  ];
}

export default defineInstrumentation({
  setup: ({ agentName }) => {
    // A missing DSN makes Sentry a no-op rather than an error, so tests and
    // credential-free clones keep working. A missing LANGSMITH_API_KEY makes
    // `langsmithSpanProcessors` return `[]`, so this stays a no-op too.
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? "development",
      release: process.env.SENTRY_RELEASE?.trim() || undefined,
      tracesSampleRate: 1.0,
      integrations:
        process.env.SENTRY_VERCEL_AI_INTEGRATION === "0"
          ? []
          : [Sentry.vercelAIIntegration({ force: true })],
      // Attaches the LangSmith export pipe onto Sentry's own OTel provider
      // instead of registering a second, competing one — see the file header.
      openTelemetrySpanProcessors: langsmithSpanProcessors(agentName),
      beforeSend(event) {
        if (event.extra) event.extra = scrub(event.extra);
        return event;
      },
    });

    Sentry.setTag("eve.component", "agent");
    Sentry.setTag("eve.agent", agentName);

    // Local span-name recorder for re-measuring emission after upgrades.
    if (process.env.EVE_SENTRY_SPAN_DEBUG === "1") {
      const logPath = process.env.EVE_SENTRY_SPAN_LOG ?? ".data/spans.log";
      mkdirSync(dirname(logPath), { recursive: true });
      const client = Sentry.getClient();
      client?.on("spanEnd", (span) => {
        try {
          const name = Sentry.spanToJSON(span).description ?? "(anonymous)";
          appendFileSync(logPath, `${name}\n`);
        } catch {
          // Diagnostics must never break the agent.
        }
      });
    }
  },

  recordInputs: RECORD_IO,
  recordOutputs: RECORD_IO,

  events: {
    "step.started"(input) {
      // Part D (EVE_LANGSMITH_TRACING_GUIDE.md §8.1): eve passes the system
      // prompt to the AI SDK as a separate `instructions` parameter, which
      // never lands on llm-run inputs in LangSmith even with recordInputs
      // on. Stash it in a file store (cross-bundle bridge — instrumentation
      // and hooks are separate module instances) so the hook can attach it,
      // untruncated, to the root summary run. Gated on content-capture
      // consent like every other piece of text in this integration.
      const instructions = (input as { modelInput?: { instructions?: string } }).modelInput
        ?.instructions;
      if (LANGSMITH_RECORD_IO && typeof instructions === "string") {
        systemPromptStore.set(input.session.id, instructions);
      }

      // Keys starting with `eve.` are reserved and silently dropped; use the
      // `app.` prefix. No user text here — counts and kinds only.
      return {
        runtimeContext: {
          "app.channel.kind": input.channel.kind ?? "unknown",
          "app.session.is_subagent": input.session.parent ? "true" : "false",
          "app.turn.sequence": String(input.turn.sequence),
        },
      };
    },
  },
});
