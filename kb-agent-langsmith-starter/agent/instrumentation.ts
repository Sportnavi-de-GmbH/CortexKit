/**
 * TRACES → self-hosted Langfuse, via the generic OTLP endpoint.
 *
 * eve's AI SDK v7 telemetry already emits gen_ai.* spans, and Langfuse maps
 * gen_ai.* attributes natively (model, tokens, cost) — so this file points a
 * standard OTLP exporter at Langfuse and then does four things that turn a
 * framework trace into a readable story:
 *
 *   1. DROPS eve's runtime plumbing (workflow/step/stream/fetch spans) and
 *      RE-PARENTS their children onto the nearest meaningful ancestor, so the
 *      tree is the agent's actual work and nothing else.
 *   2. RENAMES spans to what happened (`answer-from-knowledge-base`), not to
 *      the framework's internals (`chat gpt-4o-mini`).
 *   3. STAMPS `langfuse.*` — session on every span, environment, observation
 *      type — which is what drives Sessions, dashboards and the Agent Graph.
 *   4. STRIPS duplicate token usage so cost is counted once.
 *
 * The mere presence of this file enables eve telemetry — there is no isEnabled
 * flag. Without Langfuse credentials we skip provider registration entirely,
 * so spans have no exporter and the agent runs credential-free.
 *
 * ERRORS do not flow through here. eve never throws — failures are stream
 * events, captured by agent/hooks/langfuse.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";

import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { TraceFlags, type Context } from "@opentelemetry/api";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

import {
  LF,
  SPAN,
  STEP_PURPOSE,
  contextSummary,
  dedupeUsage,
  generationInput,
  isOversizedAttribute,
  humanSpanName,
  isMeaningfulSpanName,
  isUsageAggregatorSpan,
  isUsageAttribute,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  langfuseObservationType,
  langfuseRecordIo,
  langfuseTracesUrl,
  rememberSession,
  sessionForTrace,
  shouldExportSpan,
  systemPromptStore,
  traceCompleteness,
  traceRefs,
  turnIoStore,
} from "../lib/langfuse.ts";

const RECORD_IO = langfuseRecordIo();
const TRACE_COMPLETE = traceCompleteness();
const DEDUPE_USAGE = dedupeUsage();
const ENVIRONMENT = langfuseEnvironment();
/** Shown instead of visitor text when content capture is off. */
const REDACTED_IO = "[content capture off — set LANGFUSE_RECORD_IO=true]";

/** OTel JS 1.x exposes `parentSpanId`; 2.x moved it to `parentSpanContext`.
 *  Both are read here and both are rewritten on export, because the OTLP
 *  exporter bundled by @vercel/otel is minified and we do not depend on which
 *  one it reads — the resulting tree is verified against the live API instead. */
function parentIdOf(span: Span | ReadableSpan): string | undefined {
  const s = span as { parentSpanId?: string; parentSpanContext?: { spanId?: string } };
  return s.parentSpanId ?? s.parentSpanContext?.spanId;
}

/** Bookkeeping for every span we have seen start: its parent and its name.
 *  Name is enough to decide whether an ancestor is meaningful, and unlike
 *  attributes it is fixed at creation — which matters because a child ends
 *  BEFORE its parent, so ancestor decisions must not depend on lookahead.
 *
 *  Entries are NOT dropped when a span ends: the hook emits its summary and
 *  failure spans after the root has closed, and they still need to resolve a
 *  parent. Bounded instead, so a long-lived instance cannot leak. */
const MAX_TRACKED_SPANS = 5000;
const spanMeta = new Map<string, { parent?: string; name: string }>();

function rememberSpan(id: string, parent: string | undefined, name: string): void {
  if (spanMeta.size >= MAX_TRACKED_SPANS) {
    const oldest = spanMeta.keys().next();
    if (!oldest.done) spanMeta.delete(oldest.value);
  }
  spanMeta.set(id, { parent, name });
}

/** The nearest ancestor that survives the filter, or undefined when there is
 *  none — in which case the span becomes a root of its trace, which Langfuse
 *  handles. Never returns a span we dropped: a dangling parent would leave the
 *  child unplaceable in the tree. */
function meaningfulAncestor(spanId: string): string | undefined {
  let cursor = spanMeta.get(spanId)?.parent;
  let guard = 0;
  while (cursor && guard++ < 100) {
    const meta = spanMeta.get(cursor);
    if (!meta) return undefined;
    if (isMeaningfulSpanName(meta.name)) return cursor;
    cursor = meta.parent;
  }
  return undefined;
}

/** Find the trace root by walking to the topmost span we know about. */
function rootOf(spanId: string): string {
  let current = spanId;
  let guard = 0;
  for (;;) {
    const parent = spanMeta.get(current)?.parent;
    if (!parent || !spanMeta.has(parent) || guard++ >= 100) return current;
    current = parent;
  }
}

/** One proxy for every export-time rewrite, so a span is wrapped at most once.
 *  Methods are bound to the target so the span's internal state keeps working;
 *  timings, ids and trace id are untouched. */
function rewritten(
  span: ReadableSpan,
  name: string,
  computeAttributes: () => ReadableSpan["attributes"],
  parentSpanId: string | undefined,
): ReadableSpan {
  const parentSpanContext =
    parentSpanId === undefined
      ? undefined
      : { traceId: span.spanContext().traceId, spanId: parentSpanId, traceFlags: TraceFlags.SAMPLED };
  // LAZY, and that is the point. A span ENDS before the turn does: when
  // `generate-answer` closed, the assistant's reply had not been emitted yet,
  // so building attributes here left three spans with no output. The exporter
  // reads `.attributes` at batch-export time (BatchSpanProcessor's scheduled
  // delay), by which point the hook has published the reply. Memoized so the
  // exporter's repeated reads stay cheap and consistent.
  let cached: ReadableSpan["attributes"] | undefined;
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "name") return name;
      if (prop === "attributes") return (cached ??= computeAttributes());
      if (prop === "parentSpanId") return parentSpanId;
      if (prop === "parentSpanContext") return parentSpanContext;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function forLangfuse(span: ReadableSpan): ReadableSpan {
  const name = process.env.LANGFUSE_HUMAN_NAMES === "false" ? span.name : humanSpanName(span.name);
  const parent = TRACE_COMPLETE ? parentIdOf(span) : meaningfulAncestor(span.spanContext().spanId);
  return rewritten(span, name, () => buildAttributes(span, name), parent);
}

/** Runs at EXPORT time, not at span end — see `rewritten`. */
function buildAttributes(span: ReadableSpan, name: string): ReadableSpan["attributes"] {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(span.attributes)) {
    // Cost accuracy: the aggregator span repeats its child's token usage, and
    // Langfuse prices every observation that carries usage.
    if (DEDUPE_USAGE && isUsageAggregatorSpan(span.name) && isUsageAttribute(k)) continue;
    attributes[k] = v;
  }

  attributes[LF.environment] = ENVIRONMENT;
  const sessionId = sessionForTrace(span.spanContext().traceId);
  if (sessionId !== undefined && attributes[LF.sessionId] === undefined) {
    attributes[LF.sessionId] = sessionId;
  }
  const observationType = langfuseObservationType(span.name);
  if (observationType !== undefined && attributes[LF.observationType] === undefined) {
    attributes[LF.observationType] = observationType;
  }

  // ---------------------------------------------------------------------
  // Make the span self-explanatory.
  //
  // eve's own spans export with `input: null, output: null` — measured on a
  // real trace, three of six observations were completely empty, including
  // the root a reviewer opens first. The conversation is known only to the
  // hook, so it is bridged through `turnIoStore`; the knowledge base is known
  // only here, via `systemPromptStore`.
  // ---------------------------------------------------------------------
  const purpose = STEP_PURPOSE[name];
  if (purpose) attributes["step.purpose"] = purpose;

  if (sessionId !== undefined) {
    const io = turnIoStore.get(sessionId) ?? {};
    const systemPrompt = systemPromptStore.get(sessionId);

    // The generation gets the FULL context, because "what did the model
    // actually see" is the question a KB agent's trace has to answer. Before
    // this, its input was the user's 113-character message and nothing else.
    if (name === SPAN.generate) {
      attributes[LF.observationInput] = generationInput({
        systemPrompt,
        question: io.question,
        recordContent: RECORD_IO,
      });
    } else if (name === SPAN.applyKnowledge || name === SPAN.compose) {
      // The wrappers get the same context WITHOUT the 73 KB of prompt text —
      // repeating it at every level buries the trace.
      attributes[LF.observationInput] = contextSummary({
        systemPrompt,
        question: io.question,
        recordContent: RECORD_IO,
      });
    } else if (name === SPAN.request || name === SPAN.turn) {
      // The outer spans speak the visitor's language: question in, answer out.
      attributes[LF.observationInput] = RECORD_IO ? (io.question ?? "") : REDACTED_IO;
    }

    // Output on EVERY stage that produced one. Setting `langfuse.observation.
    // input` makes Langfuse use the explicit namespace for that observation
    // and stop falling back to the framework's gen_ai attributes, so the
    // matching output has to be supplied too — otherwise the three inner
    // stages export with an empty output (measured 2026-08-13).
    if (
      name === SPAN.request ||
      name === SPAN.turn ||
      name === SPAN.compose ||
      name === SPAN.applyKnowledge ||
      name === SPAN.generate
    ) {
      const reply = RECORD_IO ? io.reply : REDACTED_IO;
      if (reply) attributes[LF.observationOutput] = reply;
    }
  }

  // Whenever we supplied a readable input, drop the framework's escaped
  // mega-blob (79,634 chars on one measured trace) — it says the same thing
  // unreadably and dominates the payload.
  if (attributes[LF.observationInput] !== undefined) {
    for (const [k, v] of Object.entries(attributes)) {
      if (k !== LF.observationInput && isOversizedAttribute(k, v)) delete attributes[k];
    }
  }

  return attributes as ReadableSpan["attributes"];
}

/** Keeps the meaningful spans, drops eve's plumbing, and re-parents so the
 *  tree stays connected. Set LANGFUSE_EXPORT_ALL=true to bypass for debugging. */
class AgentSpanFilter implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const id = span.spanContext().spanId;
    const parent = parentIdOf(span);
    rememberSpan(id, parent, span.name);

    // eve's turn span is the only span carrying the session id. Publish it
    // twice: in memory, so every other span of this trace can be stamped with
    // `langfuse.session.id`; and to disk, so the SEPARATELY BUNDLED failure
    // hook can attach its spans to this same trace.
    if (span.name === "ai.eve.turn") {
      const sessionId = span.attributes["eve.session.id"];
      if (typeof sessionId === "string") {
        const traceId = span.spanContext().traceId;
        rememberSession(traceId, sessionId);
        // The hook's spans hang under the trace root when it survives the
        // filter, otherwise under the turn span itself.
        const root = rootOf(id);
        const rootName = spanMeta.get(root)?.name ?? "";
        traceRefs.set(sessionId, {
          traceId,
          rootSpanId: isMeaningfulSpanName(rootName) ? root : id,
        });
      }
    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    // The trace root is only worth exporting when the trace carries a visitor
    // turn (i.e. an `ai.eve.turn` child registered a session). eve's other
    // per-invocation HTTP requests produce session-less single-span traces —
    // ~20 per turn on Vercel — that only pollute the Tracing list.
    const keep =
      process.env.LANGFUSE_EXPORT_ALL === "true" ||
      shouldExportSpan(
        span.name,
        Object.keys(span.attributes),
        TRACE_COMPLETE,
        sessionForTrace(span.spanContext().traceId) !== undefined,
      );

    // Local span-debug log: separates "the exporter never saw it" from "the
    // backend hasn't ingested it yet" — two failure modes that look identical
    // in the UI. Indispensable when debugging.
    if (process.env.EVE_LF_SPAN_DEBUG === "1") {
      try {
        mkdirSync(".data", { recursive: true });
        appendFileSync(
          ".data/spans.log",
          `${keep ? "KEEP" : "DROP"} | ${span.name} → ${humanSpanName(span.name)} | parent=${meaningfulAncestor(span.spanContext().spanId) ?? "(root)"}\n`,
        );
      } catch {
        // Diagnostics must never break the agent.
      }
    }
    if (keep) this.inner.onEnd(forLangfuse(span));
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
    if (!langfuseEnabled()) return; // no credentials = no exporter, never an error

    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        new AgentSpanFilter(
          new BatchSpanProcessor(
            new OTLPHttpProtoTraceExporter({
              url: langfuseTracesUrl(),
              // Basic auth + the v4 ingestion-version header, per Langfuse's
              // OTel docs. Without the header, traces can lag ~10 minutes.
              headers: langfuseHeaders(),
            }),
          ),
        ),
      ],
    });
  },

  // Content capture is an explicit choice: this is a public, anonymous widget
  // and visitor text is personal data. Default private.
  recordInputs: RECORD_IO,
  recordOutputs: RECORD_IO,

  events: {
    "step.started"(input) {
      // eve passes the assembled system prompt to the AI SDK as a separate
      // `instructions` parameter, so gen_ai spans never carry it. It IS this
      // agent's knowledge base, so the hook fingerprints it onto the summary.
      const instructions = (input as { modelInput?: { instructions?: string } }).modelInput
        ?.instructions;
      const sessionId = (input as { session?: { id?: string } }).session?.id;
      if (typeof instructions === "string" && typeof sessionId === "string") {
        systemPromptStore.set(sessionId, instructions);
      }

      // Runtime-context values ride onto the model-call span and its children
      // (eve guide: "Runtime context"). Keys beginning with `eve.` are RESERVED
      // and silently dropped — use `app.` / `langfuse.`.
      return {
        runtimeContext: {
          [LF.environment]: ENVIRONMENT,
          ...(sessionId ? { [LF.sessionId]: sessionId } : {}),
          "app.agent.label": "KB-Agent",
          "app.channel.kind": input.channel.kind ?? "unknown",
          "app.turn.sequence": String(input.turn.sequence),
          // NOT `app.step.index` — eve's `input.step` is an object, so
          // String(...) rendered "[object Object]" in the trace. eve already
          // emits the real value as `eve.step.index`.
          "app.step.purpose": "Answer the visitor's question from the embedded knowledge base",
          "app.knowledge.mode": "prompt-embedded (no retrieval, no tools)",
        },
      };
    },
  },
});
