/**
 * PROCESS: the eve agent process (booted by `eve dev` / withEve()), NOT
 * Next.js, NOT the browser. `withEve()` runs eve as a separate process, so a
 * `Sentry.init()` (or any OTel provider registration) anywhere in the
 * Next.js layer would not instrument the agent — this file is the only
 * place agent observability can be configured (node_modules/eve/docs/guides/
 * instrumentation.md). This file existing is also what makes eve enable AI
 * SDK telemetry at all — delete it and the agent goes dark.
 *
 * THREE observability backends share this one file: Sentry (error/perf
 * monitoring, pre-existing), LangSmith (agent trace trees + cost, added per
 * EVE_LANGSMITH_TRACING_GUIDE.md) and Langfuse (the Navio-wide observability
 * layer, added 2026-08-18 — CLAUDE.md §16).
 *
 * WHY LANGFUSE WAS ADDED WITHOUT REMOVING ANYTHING: Navio's rollout gives each
 * agent its OWN Langfuse project, selected purely by the `LANGFUSE_*` keys in
 * that service's environment (§16.3b). The FAQ agent (service 1) already
 * points at "Navio — FAQ"; this service points at "Navio — Partner". Nothing
 * in either codebase names a project, so the two cannot collide and service
 * 1's configuration is untouched by this file. Sentry and LangSmith here are
 * likewise untouched — Langfuse is a THIRD, independent export pipe on the
 * same span stream, and it is a complete no-op without its credentials.
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

import { TraceFlags, type Context } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Sentry from "@sentry/node";
import { defineInstrumentation } from "eve/instrumentation";

import {
  LF,
  SPAN,
  STEP_PURPOSE,
  contextSummary,
  dedupeUsage,
  generationInput,
  humanSpanName as langfuseSpanName,
  isMeaningfulSpanName,
  isOversizedAttribute,
  isTurnScopedSpanName,
  traceTitle,
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
  shouldExportSpan as shouldExportToLangfuse,
  systemPromptStore as langfusePromptStore,
  traceCompleteness,
  traceRefs as langfuseTraceRefs,
  turnIoStore as langfuseTurnIo,
} from "../lib/langfuse";
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
const LANGFUSE_RECORD_IO = langfuseRecordIo();
const RECORD_IO =
  process.env.SENTRY_RECORD_IO === "true" || LANGSMITH_RECORD_IO || LANGFUSE_RECORD_IO;

// --- Langfuse pipe: settings read once at boot ------------------------------
const LF_TRACE_COMPLETE = traceCompleteness();
const LF_DEDUPE_USAGE = dedupeUsage();
const LF_ENVIRONMENT = langfuseEnvironment();
/** Shown instead of visitor text when Langfuse content capture is off. */
const LF_REDACTED = "[content capture off — set LANGFUSE_RECORD_IO=true]";

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

// ===========================================================================
// LANGFUSE PIPE
//
// Independent of the LangSmith pipe above: both processors receive the same
// original spans from Sentry's provider and each wraps them for its OWN
// exporter, so neither can see or corrupt the other's rewrites.
//
// Four things turn a framework trace into a readable story (CLAUDE.md §16.3b):
//   1. DROP eve's runtime plumbing and RE-PARENT its children onto the nearest
//      meaningful ancestor, so the tree is the agent's actual work.
//   2. RENAME spans to what happened (`search-partner-directory`), not to the
//      framework's internals (`execute_tool find_partners`).
//   3. STAMP `langfuse.*` — session on every span, environment, observation
//      type — which is what drives Sessions, dashboards and the Agent Graph.
//   4. STRIP duplicate token usage so a two-call turn is costed once.
// ===========================================================================

/** Bookkeeping for every span we have seen start: its parent and its name.
 *  Name is enough to decide whether an ancestor is meaningful, and unlike
 *  attributes it is fixed at creation — which matters because a child ends
 *  BEFORE its parent, so ancestor decisions must not depend on lookahead.
 *
 *  Entries are NOT dropped when a span ends: the hook emits its summary and
 *  failure spans after the root has closed, and they still need to resolve a
 *  parent. Bounded instead, so a long-lived instance cannot leak. */
const LF_MAX_TRACKED_SPANS = 5000;
const lfSpanMeta = new Map<string, { parent?: string; name: string }>();

function lfRememberSpan(id: string, parent: string | undefined, name: string): void {
  if (lfSpanMeta.size >= LF_MAX_TRACKED_SPANS) {
    const oldest = lfSpanMeta.keys().next();
    if (!oldest.done) lfSpanMeta.delete(oldest.value);
  }
  lfSpanMeta.set(id, { parent, name });
}

/** The nearest ancestor that survives the filter, or undefined when there is
 *  none — in which case the span becomes a root of its trace, which Langfuse
 *  handles. Never returns a span we dropped: a dangling parent would leave the
 *  child unplaceable in the tree. */
function lfMeaningfulAncestor(spanId: string): string | undefined {
  let cursor = lfSpanMeta.get(spanId)?.parent;
  let guard = 0;
  while (cursor && guard++ < 100) {
    const meta = lfSpanMeta.get(cursor);
    if (!meta) return undefined;
    if (isMeaningfulSpanName(meta.name)) return cursor;
    cursor = meta.parent;
  }
  return undefined;
}

/** Find the trace root by walking to the topmost span we know about. */
function lfRootOf(spanId: string): string {
  let current = spanId;
  let guard = 0;
  for (;;) {
    const parent = lfSpanMeta.get(current)?.parent;
    if (!parent || !lfSpanMeta.has(parent) || guard++ >= 100) return current;
    current = parent;
  }
}

/** One proxy for every export-time rewrite, so a span is wrapped at most once.
 *  Methods are bound to the target so the span's internal state keeps working;
 *  timings, ids and trace id are untouched. */
function lfRewritten(
  span: ReadableSpan,
  name: string,
  computeAttributes: () => ReadableSpan["attributes"],
  parentSpanId: string | undefined,
): ReadableSpan {
  const parentSpanContext =
    parentSpanId === undefined
      ? undefined
      : {
          traceId: span.spanContext().traceId,
          spanId: parentSpanId,
          traceFlags: TraceFlags.SAMPLED,
        };
  // LAZY, and that is the point. A span ENDS before the turn does: when
  // `generate-answer` closed, the assistant's reply had not been emitted yet,
  // so building attributes eagerly left the outer stages with no output. The
  // exporter reads `.attributes` at batch-export time, by which point the hook
  // has published the reply and the retrieval facts. Memoized so the
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
  const name =
    process.env.LANGFUSE_HUMAN_NAMES === "false" ? span.name : langfuseSpanName(span.name);
  const parent = LF_TRACE_COMPLETE
    ? parentIdOf(span)
    : lfMeaningfulAncestor(span.spanContext().spanId);
  return lfRewritten(span, name, () => buildLangfuseAttributes(span, name), parent);
}

/** Runs at EXPORT time, not at span end — see `lfRewritten`. */
function buildLangfuseAttributes(span: ReadableSpan, name: string): ReadableSpan["attributes"] {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(span.attributes)) {
    // Cost accuracy: the aggregator repeats its children's usage, and a
    // partner search has TWO billed calls — so leaving it in bills the turn
    // twice.
    if (LF_DEDUPE_USAGE && isUsageAggregatorSpan(span.name) && isUsageAttribute(k)) continue;
    attributes[k] = v;
  }

  attributes[LF.environment] = LF_ENVIRONMENT;
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
  // eve's own spans export with `input: null, output: null`. The conversation
  // and the retrieval facts are known only to the hook, so they are bridged
  // through `turnIoStore`; the instructions only here, via `systemPromptStore`.
  // ---------------------------------------------------------------------
  const purpose = STEP_PURPOSE[name];
  if (purpose) attributes["step.purpose"] = purpose;

  /** The model's own answer text, straight off the AI SDK span. Used when the
   *  hook has not journaled a reply yet (the serverless case). The key names
   *  differ across AI SDK versions, so all the known spellings are tried and
   *  the first non-empty string wins; returns undefined when none is present,
   *  which leaves the existing behaviour untouched. */
  function modelCompletionFrom(attrs: Record<string, unknown>): string | undefined {
    for (const key of [
      "ai.response.text",
      "gen_ai.response.text",
      "gen_ai.completion",
      "ai.response.object",
    ]) {
      const v = attrs[key];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return undefined;
  }

  if (sessionId !== undefined) {
    const io = langfuseTurnIo.get(sessionId) ?? {};
    const systemPrompt = langfusePromptStore.get(sessionId);

    if (name === SPAN.generate) {
      // The billed call gets the FULL context — instructions AND what the
      // search returned. For this agent the retrieval half is the one that
      // matters: the honesty invariant says every named business must come
      // from a find_partners result in this conversation, and this is the
      // observation that lets a reviewer check the answer against it.
      attributes[LF.observationInput] = generationInput({
        systemPrompt,
        question: io.question,
        retrieval: io.retrieval,
        recordContent: LANGFUSE_RECORD_IO,
      });
    } else if (name === SPAN.recommend || name === SPAN.step) {
      // The wrappers get the same context WITHOUT the full prompt text —
      // repeating it at every level buries the trace.
      attributes[LF.observationInput] = contextSummary({
        systemPrompt,
        question: io.question,
        retrieval: io.retrieval,
        recordContent: LANGFUSE_RECORD_IO,
      });
    } else if (name === SPAN.request || name === SPAN.turn) {
      // The outer spans speak the visitor's language: question in, answer out.
      attributes[LF.observationInput] = LANGFUSE_RECORD_IO ? (io.question ?? "") : LF_REDACTED;
    }

    // Output on EVERY stage that produced one. Setting `langfuse.observation.
    // input` makes Langfuse use the explicit namespace for that observation and
    // stop falling back to the framework's gen_ai attributes, so the matching
    // output has to be supplied too — otherwise those stages export with an
    // empty output (measured on the FAQ agent 2026-08-13).
    if (
      name === SPAN.request ||
      name === SPAN.turn ||
      name === SPAN.recommend ||
      name === SPAN.step ||
      name === SPAN.generate
    ) {
      // Fall back to the model's OWN completion when the hook's reply has not
      // been journaled yet. Setting an explicit `observation.input` stops
      // Langfuse falling back to the framework's `gen_ai.*` attributes for the
      // matching output, so without this the billed call exported with
      // `output: null` in production — the turn ends in a LATER serverless
      // invocation than the model call, so `io.reply` is simply not there yet.
      const reply = LANGFUSE_RECORD_IO
        ? (io.reply ?? modelCompletionFrom(span.attributes))
        : LF_REDACTED;
      if (reply) attributes[LF.observationOutput] = reply;
    }

    // ---------------------------------------------------------------------
    // TRACE-LEVEL fields, stamped HERE rather than on the hook's summary span.
    //
    // Langfuse reads `langfuse.trace.*` from ANY span in the trace, so the
    // trace title and its input/output do not need a dedicated span — they
    // need a span that HAS the data. On Vercel the hook's `answer-delivered`
    // never gets that data: eve splits a tool-using turn across several
    // serverless invocations and the turn-end event lands in one where the
    // journal is empty (measured 2026-09-08), so the summary was never emitted
    // and every production trace listed as an opaque id with no I/O.
    //
    // The model call does have it, in the same invocation that produced it.
    // Stamping the trace fields here removes the cross-invocation dependency
    // instead of trying to carry state across it. When the hook DOES run (dev,
    // and any single-invocation turn) it writes the same fields afterwards and
    // simply wins — the values agree, so there is no conflict either way.
    // ---------------------------------------------------------------------
    if (name === SPAN.generate) {
      const question = io.question;
      const reply = LANGFUSE_RECORD_IO
        ? (io.reply ?? modelCompletionFrom(span.attributes))
        : undefined;
      if (attributes[LF.traceName] === undefined) {
        attributes[LF.traceName] = traceTitle(question, LANGFUSE_RECORD_IO, 1);
      }
      if (attributes[LF.traceInput] === undefined) {
        attributes[LF.traceInput] = LANGFUSE_RECORD_IO ? (question ?? "") : LF_REDACTED;
      }
      if (reply && attributes[LF.traceOutput] === undefined) {
        attributes[LF.traceOutput] = reply;
      }
    }
  }

  // Whenever we supplied a readable input, drop the framework's escaped
  // mega-blob — for this agent that blob contains every rendered partner
  // profile from the tool result, which is the single largest thing in the
  // trace and says the same thing unreadably.
  if (attributes[LF.observationInput] !== undefined) {
    for (const [k, v] of Object.entries(attributes)) {
      if (k !== LF.observationInput && isOversizedAttribute(k, v)) delete attributes[k];
    }
  }

  return attributes as ReadableSpan["attributes"];
}

/** Keeps the meaningful spans, drops eve's plumbing, and re-parents so the
 *  tree stays connected. Set LANGFUSE_EXPORT_ALL=true to bypass for debugging. */
class LangfuseSpanFilter implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const id = span.spanContext().spanId;
    const parent = parentIdOf(span);
    lfRememberSpan(id, parent, span.name);

    // eve's turn span is the only span carrying the session id. Publish it
    // twice: in memory, so every other span of this trace can be stamped with
    // `langfuse.session.id`; and to disk, so the SEPARATELY BUNDLED hook can
    // attach its summary and failure spans to this same trace.
    // eve 0.25.x emits `eve.turn`; the docs also show `ai.eve.turn`. Accept both.
    if (span.name === "ai.eve.turn" || span.name === "eve.turn") {
      const sessionId = span.attributes["eve.session.id"];
      if (typeof sessionId === "string" && sessionId !== "") {
        const traceId = span.spanContext().traceId;
        rememberSession(traceId, sessionId);
        // The hook's spans hang under the trace root when it survives the
        // filter, otherwise under the turn span itself.
        const root = lfRootOf(id);
        const rootName = lfSpanMeta.get(root)?.name ?? "";
        langfuseTraceRefs.set(sessionId, {
          traceId,
          rootSpanId: isMeaningfulSpanName(rootName) ? root : id,
        });
      }
    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    let keep =
      process.env.LANGFUSE_EXPORT_ALL === "true" ||
      shouldExportToLangfuse(span.name, Object.keys(span.attributes), LF_TRACE_COMPLETE);

    // Drop request spans that never ran an agent turn. eve emits
    // `workflow.route.flow` for EVERY request its runtime handles — dev-console
    // polling, stream reads, health probes — and each one arrives with no
    // session, no children and no content, becoming its own junk trace.
    // MEASURED on the first live run: 78 orphans against 2 real traces.
    //
    // Safe to decide here: a request span ends AFTER its children, so if a turn
    // ever started, `rememberSession` has already run for this trace id.
    if (
      keep &&
      !LF_TRACE_COMPLETE &&
      process.env.LANGFUSE_EXPORT_ALL !== "true" &&
      isTurnScopedSpanName(span.name) &&
      sessionForTrace(span.spanContext().traceId) === undefined
    ) {
      keep = false;
    }

    // Local span-debug log: separates "the exporter never saw it" from "the
    // backend hasn't ingested it yet" — two failure modes that look identical
    // in the UI, because OTLP returns 200 on enqueue.
    if (process.env.EVE_LF_SPAN_DEBUG === "1") {
      try {
        const logPath = process.env.EVE_LF_SPAN_LOG ?? ".data/langfuse-spans.log";
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(
          logPath,
          `${keep ? "KEEP" : "DROP"} | ${span.name} -> ${langfuseSpanName(span.name)} | parent=${lfMeaningfulAncestor(span.spanContext().spanId) ?? "(root)"}\n`,
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

function langfuseSpanProcessors(): SpanProcessor[] {
  // No host or either key missing = no exporter at all, never an error. This
  // is what keeps a credential-free clone (and the FAQ agent's environment)
  // completely unaffected.
  if (!langfuseEnabled()) return [];

  return [
    new LangfuseSpanFilter(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: langfuseTracesUrl(),
          // Basic auth + the v4 ingestion-version header, per Langfuse's OTel
          // docs. Without the header, traces can lag ~10 minutes and you will
          // think the integration is broken.
          headers: langfuseHeaders(),
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
      // Attaches the LangSmith and Langfuse export pipes onto Sentry's own
      // OTel provider instead of registering a second, competing one — see the
      // file header. Order is irrelevant: each processor wraps spans for its
      // own exporter and neither mutates the original.
      //
      // VERIFIED, not assumed: @sentry/node's `init()` constructs a client and
      // calls `initOpenTelemetry(client, { spanProcessors })` unconditionally —
      // it is NOT gated on a DSN (node_modules/@sentry/node/build/esm/sdk/
      // index.js, and node-core's `_init` always returns a client). That
      // matters because SENTRY_DSN is unset in this project's .env.local, so a
      // DSN-gated registration would have made both pipes silently dark.
      openTelemetrySpanProcessors: [
        ...langsmithSpanProcessors(agentName),
        ...langfuseSpanProcessors(),
      ],
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

      // Langfuse keeps its OWN copy in a separate `.data/langfuse-prompts`
      // store, so the two integrations cannot corrupt each other's state and
      // either can be removed without touching the other. Unlike LangSmith's,
      // this one is NOT gated on content capture: the prompt is only ever
      // fingerprinted (digest, size, section list) unless
      // LANGFUSE_RECORD_SYSTEM_PROMPT=true, and that fingerprint is what
      // answers "which instructions produced this answer".
      if (typeof instructions === "string") {
        langfusePromptStore.set(input.session.id, instructions);
      }

      // Keys starting with `eve.` are reserved and silently dropped; use the
      // `app.` / `langfuse.` prefixes. No user text here — counts and kinds only.
      return {
        runtimeContext: {
          [LF.environment]: LF_ENVIRONMENT,
          [LF.sessionId]: input.session.id,
          "app.agent.label": "Partner-Agent",
          "app.channel.kind": input.channel.kind ?? "unknown",
          "app.session.is_subagent": input.session.parent ? "true" : "false",
          "app.turn.sequence": String(input.turn.sequence),
          "app.step.purpose":
            "Find real Sportnavi partners near the visitor's city and describe them honestly",
          "app.knowledge.mode": "retrieval (Supabase directory + embedding similarity)",
        },
      };
    },
  },
});
