/**
 * TRACES → LangSmith EU, via the generic OTLP endpoint (guide Steps A2–A4,
 * Part C anchor publishing, Part D system-prompt capture).
 *
 * eve's AI SDK v7 telemetry already emits gen_ai.* spans, and LangSmith's
 * /otel endpoint maps gen_ai.* attributes natively — so this file only points
 * a standard OTLP exporter at LangSmith, filters out workflow noise, renames
 * spans for humans, and publishes trace anchors. No LangSmith SDK on this
 * path. We deliberately do NOT stack LangSmith's experimental Vercel AI
 * integration on top: eve registers the AI SDK telemetry itself.
 *
 * The mere presence of this file enables eve telemetry — there is no
 * isEnabled flag. With no LANGSMITH_API_KEY we skip provider registration
 * entirely, so spans have no exporter and the agent runs credential-free.
 *
 * ERRORS do not flow through here. eve never throws — failures are stream
 * events, captured by agent/hooks/langsmith.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";

import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Context } from "@opentelemetry/api";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

import {
  LANGSMITH_EU_OTEL_TRACES_URL,
  dedupeUsage,
  dottedStampFromHr,
  humanSpanName,
  isUsageAggregatorSpan,
  isUsageAttribute,
  langsmithEnabled,
  otelRunId,
  projectName,
  recordIo,
  shouldExportSpan,
  SpanFilterState,
  systemPromptStore,
  traceAnchors,
  traceCompleteness,
} from "../lib/langsmith.ts";

const RECORD_IO = recordIo();
/** Export the full eve execution graph (workflow nodes + steps + network),
 *  not just AI spans + ancestors, so the complete flow is inspectable in one
 *  trace. Opt out with LANGSMITH_TRACE_COMPLETENESS=ai. */
const TRACE_COMPLETE = traceCompleteness();
/** Strip usage from the aggregator span so LangSmith prices each model call
 *  once (accurate cost). Opt out with LANGSMITH_DEDUPE_USAGE=false. */
const DEDUPE_USAGE = dedupeUsage();

/** OTel JS 1.x exposes `parentSpanId`; 2.x moved it to `parentSpanContext`. */
function parentIdOf(span: Span | ReadableSpan): string | undefined {
  const s = span as { parentSpanId?: string; parentSpanContext?: { spanId?: string } };
  return s.parentSpanId ?? s.parentSpanContext?.spanId;
}

/** §9.2: rewrite the span NAME to business language just before export.
 *  Attributes and identity are untouched — the proxy forwards everything
 *  else to the real span (methods bound to the target so internal state
 *  keeps working). Disable with LANGSMITH_HUMAN_NAMES=false to A/B against
 *  raw framework names. */
function withHumanName(span: ReadableSpan): ReadableSpan {
  const name = humanSpanName(span.name);
  if (name === span.name) return span;
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "name") return name;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** COST ACCURACY (§8): strip token-usage attributes from eve's `invoke_agent`
 *  aggregator span so LangSmith prices only the inner per-call `chat` spans.
 *  Otherwise the aggregator and its inner call both carry the same usage and
 *  the trace double-counts tokens & cost (~2×). Names/identity untouched —
 *  runs the check on the RAW span name, so compose it BEFORE withHumanName. */
function withoutAggregateUsage(span: ReadableSpan): ReadableSpan {
  if (!DEDUPE_USAGE || !isUsageAggregatorSpan(span.name)) return span;
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(span.attributes)) {
    if (!isUsageAttribute(k)) filtered[k] = v;
  }
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "attributes") return filtered as ReadableSpan["attributes"];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Drops eve's Workflow SDK noise spans before they reach LangSmith, while
 *  still exporting every ANCESTOR of an AI span: LangSmith silently drops
 *  spans whose parent never arrives, so an AI-only filter exports nothing.
 *  Set LANGSMITH_EXPORT_ALL=true to bypass for debugging. */
class AiSpanFilter implements SpanProcessor {
  private readonly state = new SpanFilterState();
  /** spanId → {parent, start} for anchor computation (one trace per request:
   *  the hook nests its runs under the OTLP root via lib traceAnchors). */
  private readonly open = new Map<string, { parent?: string; sec: number; nanos: number }>();
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const id = span.spanContext().spanId;
    const parent = parentIdOf(span);
    this.state.onStart(id, parent);
    const [sec, nanos] = span.startTime;
    this.open.set(id, { parent, sec, nanos });
    // eve's turn span carries the session id — walk up to the trace root and
    // publish the anchor so the hook can pre-create the root run (Part C).
    if (span.name === "ai.eve.turn") {
      const sessionId = span.attributes["eve.session.id"];
      if (typeof sessionId === "string") {
        let rootId = id;
        let guard = 0;
        for (let e = this.open.get(rootId); e?.parent && guard++ < 100; e = this.open.get(rootId)) {
          if (!this.open.has(e.parent)) break;
          rootId = e.parent;
        }
        const root = this.open.get(rootId);
        if (root) {
          const runId = otelRunId(rootId);
          traceAnchors.set(sessionId, {
            rootRunId: runId,
            rootDotted: `${dottedStampFromHr(root.sec, root.nanos)}${runId}`,
            rootStartMs: root.sec * 1000 + Math.floor(root.nanos / 1e6),
          });
        }
      }
    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.open.delete(span.spanContext().spanId);
    const keepByRule = shouldExportSpan(span.name, Object.keys(span.attributes), TRACE_COMPLETE);
    const keep =
      process.env.LANGSMITH_EXPORT_ALL === "true" ||
      this.state.onEnd(span.spanContext().spanId, parentIdOf(span), keepByRule);
    // Local span-debug log: separates "exporter never saw it" from "backend
    // hasn't ingested it yet" — the two failure modes that look identical
    // from the UI. Indispensable when debugging.
    if (process.env.EVE_LS_SPAN_DEBUG === "1") {
      try {
        mkdirSync(".data", { recursive: true });
        appendFileSync(
          ".data/spans.log",
          `${keep ? "KEEP" : "DROP"}${keepByRule ? " rule" : ""} | ${span.name} | ${Object.keys(span.attributes).slice(0, 10).join(",")}\n`,
        );
      } catch {
        // Diagnostics must never break the agent.
      }
    }
    if (keep) {
      // Dedupe usage on the RAW span (name check), then rename for humans.
      const deduped = withoutAggregateUsage(span);
      this.inner.onEnd(
        process.env.LANGSMITH_HUMAN_NAMES === "false" ? deduped : withHumanName(deduped),
      );
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

export default defineInstrumentation({
  setup: ({ agentName }) => {
    if (!langsmithEnabled()) return; // no key = no exporter, never an error

    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        new AiSpanFilter(
          new BatchSpanProcessor(
            new OTLPHttpProtoTraceExporter({
              url: LANGSMITH_EU_OTEL_TRACES_URL,
              headers: {
                // Auth + project routing per LangSmith's OTel ingestion docs.
                "x-api-key": process.env.LANGSMITH_API_KEY ?? "",
                "Langsmith-Project": projectName(process.env, agentName),
              },
            }),
          ),
        ),
      ],
    });
  },

  // Content capture is an explicit choice (§4). Default private.
  recordInputs: RECORD_IO,
  recordOutputs: RECORD_IO,

  events: {
    "step.started"(input) {
      // Part D: eve passes the assembled system prompt to the AI SDK as a
      // separate `instructions` parameter, so gen_ai spans never carry it.
      // Stash it for the hook, which writes it onto the root summary run.
      const instructions = (input as { modelInput?: { instructions?: string } }).modelInput
        ?.instructions;
      const sessionId = (input as { session?: { id?: string } }).session?.id;
      if (RECORD_IO && typeof instructions === "string" && typeof sessionId === "string") {
        systemPromptStore.set(sessionId, instructions);
      }

      // Keys beginning with `eve.` are RESERVED and silently dropped — use
      // `app.`. These ride onto the AI spans as searchable run metadata.
      return {
        runtimeContext: {
          "app.channel.kind": input.channel.kind ?? "unknown",
          "app.turn.sequence": String(input.turn.sequence),
          "app.step.purpose": "Choosing and executing the next action for the user's request",
          "app.action": "process_user_request",
        },
      };
    },
  },
});
