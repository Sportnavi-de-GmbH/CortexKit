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
import { TraceFlags, type Context } from "@opentelemetry/api";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

import {
  LF,
  SPAN as LF_SPAN,
  STEP_PURPOSE as LF_STEP_PURPOSE,
  childSessions,
  contextSummary,
  rememberDelegation,
  dedupeUsage as langfuseDedupeUsage,
  generationInput,
  humanSpanName as langfuseSpanName,
  isMeaningfulSpanName as isLangfuseMeaningful,
  isOversizedAttribute,
  isTurnScopedSpanName,
  isUsageAggregatorSpan as isLangfuseAggregator,
  isUsageAttribute as isLangfuseUsageAttr,
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
  traceCompleteness as langfuseTraceCompleteness,
  traceRefs as langfuseTraceRefs,
  turnIoStore as langfuseTurnIo,
} from "../lib/langfuse.ts";
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

// --- Langfuse pipe: settings read once at boot -----------------------------
// NOTE the completeness default is the OPPOSITE of the LangSmith pipe above.
// LangSmith here exports eve's whole execution graph; Langfuse is priced per
// observation, and exporting the graph measured 112 observations for ONE turn
// on the FAQ agent (89 of them transport chatter). Lean by default.
const LF_RECORD_IO = langfuseRecordIo();
const LF_TRACE_COMPLETE = langfuseTraceCompleteness();
const LF_DEDUPE_USAGE = langfuseDedupeUsage();
const LF_ENVIRONMENT = langfuseEnvironment();
const LF_REDACTED = "[content capture off — set LANGFUSE_RECORD_IO=true]";

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

// ===========================================================================
// LANGFUSE PIPE  →  project "Navio — Multi-Agent"
//
// Independent of the LangSmith pipe above: both processors receive the same
// spans and each wraps them for its OWN exporter, so neither can corrupt the
// other's rewrites.
//
// Beyond the usual filter/rename/stamp work, this pipe solves the problem that
// only exists in a multi-agent service: A DELEGATED SUBAGENT RUNS IN ITS OWN
// CHILD SESSION, so its spans would otherwise form a second, parentless trace
// and the delegation would be disconnected from the work it caused. See
// `attachChildTrace` below.
// ===========================================================================

const LF_MAX_TRACKED_SPANS = 5000;
const lfSpanMeta = new Map<string, { parent?: string; name: string }>();

function lfRememberSpan(id: string, parent: string | undefined, name: string): void {
  if (lfSpanMeta.size >= LF_MAX_TRACKED_SPANS) {
    const oldest = lfSpanMeta.keys().next();
    if (!oldest.done) lfSpanMeta.delete(oldest.value);
  }
  lfSpanMeta.set(id, { parent, name });
}

function lfMeaningfulAncestor(spanId: string): string | undefined {
  let cursor = lfSpanMeta.get(spanId)?.parent;
  let guard = 0;
  while (cursor && guard++ < 100) {
    const meta = lfSpanMeta.get(cursor);
    if (!meta) return undefined;
    if (isLangfuseMeaningful(meta.name)) return cursor;
    cursor = meta.parent;
  }
  return undefined;
}

function lfRootOf(spanId: string): string {
  let current = spanId;
  let guard = 0;
  for (;;) {
    const parent = lfSpanMeta.get(current)?.parent;
    if (!parent || !lfSpanMeta.has(parent) || guard++ >= 100) return current;
    current = parent;
  }
}

/**
 * Child OTel trace id → the parent request's trace, for delegated subagents.
 *
 * Populated when a child session's turn span starts (see onStart). Every span
 * carrying one of these trace ids is re-stamped onto the parent's trace, so the
 * FAQ specialist's model call appears UNDER the delegation that caused it
 * instead of in a trace of its own.
 */
const lfChildTraces = new Map<
  string,
  { traceId: string; rootSpanId: string; parentSessionId: string }
>();

/** Parent session → its `navio-turn` span id, so a delegated child's subtree
 *  hangs beside the router's passes rather than off the very root. */
const lfTurnSpanBySession = new Map<string, string>();

/**
 * Link a delegated child session to the request that spawned it.
 *
 * WHY THIS RUNS FROM `step.started` AND NOT FROM A SPAN:
 * The child's own spans identify it only by its own `eve.session.id`; nothing
 * on them points at the parent. `subagent.called` — the one event carrying
 * `childSessionId` — never reaches hooks (measured). The one place the lineage
 * IS available is the instrumentation `step.started` callback, whose `session`
 * carries "parent session lineage when this is a child run"
 * (node_modules/eve/docs/guides/instrumentation.md).
 *
 * ORDERING: the child's turn span starts BEFORE its first step, so by the time
 * we learn the lineage the child has already been registered as a root session.
 * This therefore RETRO-FIXES that registration. It works because span
 * attributes are built lazily at batch-export time, which happens later still.
 */
function linkChildSession(childSessionId: string, parentSessionId: string, tool: string): void {
  if (!childSessionId || !parentSessionId || childSessionId === parentSessionId) return;

  // Idempotent, and deliberately NOT short-circuited on "already linked": a
  // replayed step gives the SAME child session a NEW trace, and an early return
  // here would leave that trace unmapped (an orphan). The per-trace guard below
  // is the one that prevents redundant work.
  childSessions.set(childSessionId, { parentSessionId, tool });
  rememberDelegation(parentSessionId, childSessionId);

  const childRef = langfuseTraceRefs.get(childSessionId);
  if (!childRef) return;
  if (sessionForTrace(childRef.traceId) === parentSessionId) return; // this trace is done

  // Re-key the child's trace onto the parent's session so Langfuse's Sessions
  // view shows ONE request instead of two.
  rememberSession(childRef.traceId, parentSessionId);

  const parentRef = langfuseTraceRefs.get(parentSessionId);
  if (parentRef && parentRef.traceId !== childRef.traceId) {
    lfChildTraces.set(childRef.traceId, {
      traceId: parentRef.traceId,
      // Hang the specialist's work under the request's TURN span, so it sits
      // beside the router's passes and the tree reads in execution order.
      rootSpanId: lfTurnSpanBySession.get(parentSessionId) ?? parentRef.rootSpanId,
      parentSessionId,
    });
  }
  // The child is not a request of its own — drop its root ref so nothing
  // (including the hook) treats it as one.
  langfuseTraceRefs.delete(childSessionId);
}

/** Attach a child session's trace to its parent request, if this span is the
 *  child's turn span and the parent is known. Returns silently otherwise —
 *  when eve happens to propagate context in-process the trace ids already
 *  match and there is nothing to do. */
/** eve puts the session id on its turn span as `eve.session.id`; on AI SDK
 *  spans it arrives via runtime context, namespaced by the SDK. Read both —
 *  relying on the bare key alone misses every span of a REPLAYED step. */
function sessionIdOf(span: Span | ReadableSpan): string | undefined {
  const direct = span.attributes["eve.session.id"];
  if (typeof direct === "string" && direct !== "") return direct;
  const viaContext = span.attributes["ai.settings.context.eve.session.id"];
  if (typeof viaContext === "string" && viaContext !== "") return viaContext;
  return undefined;
}

function attachChildTrace(span: Span, spanId: string): void {
  const sessionId = sessionIdOf(span);
  if (sessionId === undefined) return;
  const traceId = span.spanContext().traceId;

  // IS THIS A DELEGATED CHILD?
  //
  // Decided HERE, in the span processor, because it is the only place that can
  // know. `subagent.called` — the one event carrying `childSessionId` — never
  // reaches the hook layer (measured 2026-08-18 with a wildcard hook: hooks get
  // `subagent.completed`, which does not carry it). But the child's own turn
  // span does carry its `eve.session.id`, and eve propagates OTel context into
  // a local subagent, so the child's turn span arrives on the PARENT's trace
  // with a session id that differs from the one already registered for it.
  // That mismatch is the delegation signal.
  const known = sessionForTrace(traceId);
  const alreadyLinked = childSessions.get(sessionId);
  const isDelegatedChild = alreadyLinked !== undefined || (known !== undefined && known !== sessionId);

  if (!isDelegatedChild) {
    // Only the TURN span may define a request's root. Now that this runs for
    // every span that knows its session, an ordinary model span would otherwise
    // overwrite the root ref and the turn-span attach point with itself.
    if (span.name !== "ai.eve.turn" && span.name !== "eve.turn") return;

    // A root session: publish its own trace ref for the hook. It may later turn
    // out to be a delegated child — `linkChildSession` retro-fixes that once
    // eve reveals the lineage in `step.started`.
    rememberSession(traceId, sessionId);
    const root = lfRootOf(spanId);
    const rootName = lfSpanMeta.get(root)?.name ?? "";
    langfuseTraceRefs.set(sessionId, {
      traceId,
      rootSpanId: isLangfuseMeaningful(rootName) ? root : spanId,
    });
    // Remember the turn span itself as the attach point for any child.
    lfTurnSpanBySession.set(sessionId, spanId);
    return;
  }

  const parentSessionId = alreadyLinked?.parentSessionId ?? known!;
  // Remember the link so every later span of this child can be LABELLED as the
  // specialist rather than the router, and so the request's summary can list
  // the child sessions it spawned.
  childSessions.set(sessionId, { parentSessionId, tool: alreadyLinked?.tool ?? "faq" });
  rememberDelegation(parentSessionId, sessionId);

  // Keep the request's session mapping pointing at the PARENT, so Langfuse's
  // Sessions view shows one request rather than two.
  rememberSession(traceId, parentSessionId);

  // Graft only if eve did NOT already share the trace. Measured: for a LOCAL
  // subagent it does, so this is a no-op — it exists for the remote-subagent
  // case (defineRemoteAgent), where context cannot propagate in-process.
  const parentRef = langfuseTraceRefs.get(parentSessionId);
  if (!parentRef || parentRef.traceId === traceId) return;
  lfChildTraces.set(traceId, { ...parentRef, parentSessionId });
}

function lfRewritten(
  span: ReadableSpan,
  name: string,
  computeAttributes: () => ReadableSpan["attributes"],
  parentSpanId: string | undefined,
  traceIdOverride?: string,
): ReadableSpan {
  const originalCtx = span.spanContext();
  const traceId = traceIdOverride ?? originalCtx.traceId;
  const parentSpanContext =
    parentSpanId === undefined
      ? undefined
      : { traceId, spanId: parentSpanId, traceFlags: TraceFlags.SAMPLED };
  // LAZY: a span ENDS before the turn does, so building attributes eagerly
  // leaves the outer stages with no output. The exporter reads `.attributes` at
  // batch-export time, by which point the hook has published the reply and the
  // routing decision. Memoized so repeated reads stay consistent.
  let cached: ReadableSpan["attributes"] | undefined;
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "name") return name;
      if (prop === "attributes") return (cached ??= computeAttributes());
      if (prop === "parentSpanId") return parentSpanId;
      if (prop === "parentSpanContext") return parentSpanContext;
      // Re-homing a delegated child's span onto the parent trace means its
      // trace id has to change too — the span id is left alone, so nothing
      // collides and every internal reference still resolves.
      if (prop === "spanContext" && traceIdOverride) {
        return () => ({ ...originalCtx, traceId: traceIdOverride });
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function forLangfuse(span: ReadableSpan): ReadableSpan {
  const name =
    process.env.LANGFUSE_HUMAN_NAMES === "false" ? span.name : langfuseSpanName(span.name);
  const spanId = span.spanContext().spanId;
  const attach = lfChildTraces.get(span.spanContext().traceId);

  let parent = LF_TRACE_COMPLETE ? parentIdOf(span) : lfMeaningfulAncestor(spanId);
  // The child trace's own root has no surviving ancestor of its own — hang it
  // under the parent request's root so the delegation and its work are one tree.
  if (attach && parent === undefined) parent = attach.rootSpanId;

  return lfRewritten(
    span,
    name,
    () => buildLangfuseAttributes(span, name),
    parent,
    attach?.traceId,
  );
}

/** Runs at EXPORT time, not at span end — see `lfRewritten`. */
function buildLangfuseAttributes(span: ReadableSpan, name: string): ReadableSpan["attributes"] {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(span.attributes)) {
    if (LF_DEDUPE_USAGE && isLangfuseAggregator(span.name) && isLangfuseUsageAttr(k)) continue;
    attributes[k] = v;
  }

  attributes[LF.environment] = LF_ENVIRONMENT;
  const sessionId = sessionForTrace(span.spanContext().traceId);
  if (sessionId !== undefined) {
    // Overwrite rather than defer: a delegated child's spans carry the CHILD's
    // eve.session.id, and leaving that in place would split one request across
    // two Langfuse sessions.
    attributes[LF.sessionId] = sessionId;
  }
  const observationType = langfuseObservationType(span.name);
  if (observationType !== undefined && attributes[LF.observationType] === undefined) {
    attributes[LF.observationType] = observationType;
  }

  const purpose = LF_STEP_PURPOSE[name];
  if (purpose) attributes["step.purpose"] = purpose;

  // Mark which agent produced this span. In a multi-agent trace "who did this"
  // is the first question, and it cannot be read off the span name because the
  // router and the subagent emit the same framework spans.
  const rawSession = span.attributes["eve.session.id"];
  const delegated =
    typeof rawSession === "string" ? childSessions.get(rawSession) : undefined;
  if (delegated) {
    attributes["app.agent.label"] = `${delegated.tool}-subagent`;
    attributes["app.agent.role"] = "delegated specialist (own child session)";
    attributes["app.parent.session_id"] = delegated.parentSessionId;
  }

  if (sessionId !== undefined) {
    const io = langfuseTurnIo.get(sessionId) ?? {};
    const systemPrompt = langfusePromptStore.get(sessionId);

    if (name === LF_SPAN.generate) {
      attributes[LF.observationInput] = generationInput({
        systemPrompt,
        question: io.question,
        route: io.route,
        recordContent: LF_RECORD_IO,
      });
    } else if (name === LF_SPAN.orchestrate || name === LF_SPAN.step) {
      attributes[LF.observationInput] = contextSummary({
        systemPrompt,
        question: io.question,
        route: io.route,
        recordContent: LF_RECORD_IO,
      });
    } else if (name === LF_SPAN.request || name === LF_SPAN.turn) {
      attributes[LF.observationInput] = LF_RECORD_IO ? (io.question ?? "") : LF_REDACTED;
    }

    // Setting `langfuse.observation.input` makes Langfuse stop falling back to
    // the framework's gen_ai attributes for that observation, so the matching
    // output has to be supplied too — otherwise those stages export empty.
    if (
      name === LF_SPAN.request ||
      name === LF_SPAN.turn ||
      name === LF_SPAN.orchestrate ||
      name === LF_SPAN.step ||
      name === LF_SPAN.generate
    ) {
      const reply = LF_RECORD_IO ? io.reply : LF_REDACTED;
      if (reply) attributes[LF.observationOutput] = reply;
    }
  }

  if (attributes[LF.observationInput] !== undefined) {
    for (const [k, v] of Object.entries(attributes)) {
      if (k !== LF.observationInput && isOversizedAttribute(k, v)) delete attributes[k];
    }
  }

  return attributes as ReadableSpan["attributes"];
}

class LangfuseSpanFilter implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const id = span.spanContext().spanId;
    lfRememberSpan(id, parentIdOf(span), span.name);
    // Run for ANY span that knows its session, not just the turn span.
    //
    // WHY: eve's durable workflow REPLAYS steps, and a replayed subagent step
    // emits its `invoke_agent` span in a BRAND-NEW OTel trace with NO turn span
    // in it. Keying attachment on the turn span alone left exactly one such
    // span stranded per delegated request — a single-observation orphan trace,
    // measured 2026-08-18 (trace ae5ebd13, `gen_ai.agent.name=faq`).
    if (sessionIdOf(span) !== undefined) {
      attachChildTrace(span, id);
    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    let keep =
      process.env.LANGFUSE_EXPORT_ALL === "true" ||
      shouldExportToLangfuse(span.name, Object.keys(span.attributes), LF_TRACE_COMPLETE);

    // Drop request spans that never ran a turn. eve emits
    // `workflow.route.flow` for EVERY request its runtime handles — dev-console
    // polling included — and each becomes its own single-span junk trace.
    // Measured on the partner agent: 78 orphans against 2 real traces.
    // DROP ANYTHING THAT BELONGS TO NO REQUEST.
    //
    // Every legitimate span sits in a trace whose turn span registered a
    // session. Two kinds of span fail that test, and both are junk:
    //   * `workflow.route.flow` for requests that never start a turn
    //     (dev-console polling) — 78 of them against 2 real traces, measured on
    //     the partner agent;
    //   * eve's outer `invoke_agent` wrapper for a REPLAYED subagent step,
    //     which lands in a brand-new trace carrying no session, no usage and no
    //     I/O (measured 2026-08-18, trace ea2b2a78: `scope.name=eve`,
    //     `gen_ai.agent.name=faq`, `usage={}`). It duplicates work already in
    //     the request's trace, so keeping it would add an orphan row AND risk
    //     double-counting.
    if (
      keep &&
      !LF_TRACE_COMPLETE &&
      process.env.LANGFUSE_EXPORT_ALL !== "true" &&
      sessionForTrace(span.spanContext().traceId) === undefined
    ) {
      keep = false;
    }

    // A re-homed child carries its OWN request/turn wrappers, which are exact
    // duplicates of the parent's — grafting them would show two
    // `visitor-request` and two `navio-turn` nodes for one request. Drop them
    // and let the specialist's `orchestrate-request` attach directly under the
    // parent's turn, so the tree reads in execution order.
    if (
      keep &&
      process.env.LANGFUSE_EXPORT_ALL !== "true" &&
      lfChildTraces.has(span.spanContext().traceId) &&
      (span.name === "workflow.route.flow" ||
        span.name === "ai.eve.turn" ||
        span.name === "eve.turn")
    ) {
      keep = false;
    }

    if (process.env.EVE_LF_SPAN_DEBUG === "1") {
      try {
        mkdirSync(".data", { recursive: true });
        const attach = lfChildTraces.get(span.spanContext().traceId);
        appendFileSync(
          ".data/langfuse-spans.log",
          `${keep ? "KEEP" : "DROP"} | ${span.name} -> ${langfuseSpanName(span.name)}` +
            `${attach ? " [re-homed onto parent trace]" : ""}\n`,
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
  // No host or either key missing = no exporter at all, never an error.
  if (!langfuseEnabled()) return [];
  return [
    new LangfuseSpanFilter(
      new BatchSpanProcessor(
        new OTLPHttpProtoTraceExporter({
          url: langfuseTracesUrl(),
          // Basic auth + the v4 ingestion-version header. Without the header,
          // traces can lag ~10 minutes and you will think this is broken.
          headers: langfuseHeaders(),
        }),
      ),
    ),
  ];
}

function langsmithSpanProcessors(agentName: string): SpanProcessor[] {
  if (!langsmithEnabled()) return []; // no key = no exporter, never an error
  return [
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
  ];
}

export default defineInstrumentation({
  setup: ({ agentName }) => {
    // Both backends ride ONE provider. `@opentelemetry/api`'s global tracer
    // provider is a process-wide singleton — the first registration wins and
    // later ones are silently ignored — so registering twice would leave the
    // second backend looking wired while receiving nothing.
    //
    // Previously this returned early unless LangSmith was configured; that
    // would have made Langfuse silently dark for anyone without a LangSmith
    // key. Register when EITHER is configured, with neither required.
    const spanProcessors = [...langsmithSpanProcessors(agentName), ...langfuseSpanProcessors()];
    if (spanProcessors.length === 0) return; // no credentials = no exporter

    registerOTel({ serviceName: agentName, spanProcessors });
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

      // Langfuse keeps its OWN copy in a separate store, so the two pipes cannot
      // corrupt each other and either can be removed without touching the other.
      // Unlike LangSmith's, this is NOT gated on content capture: the prompt is
      // only ever fingerprinted unless LANGFUSE_RECORD_SYSTEM_PROMPT=true, and
      // that fingerprint is what answers "which routing rules produced this
      // decision". Keyed by the REQUEST session, so a delegated subagent's
      // prompt does not overwrite the router's.
      if (typeof instructions === "string" && typeof sessionId === "string") {
        langfusePromptStore.set(sessionId, instructions);
      }

      // THE DELEGATION LINK. eve's `session` carries "parent session lineage
      // when this is a child run" (docs/guides/instrumentation.md) — the only
      // place a child can be tied to the request that spawned it. Without this
      // the FAQ specialist's whole execution (its own visitor-request →
      // navio-turn → orchestrate-request → model-call) forms a SECOND,
      // unrelated trace: measured live 2026-08-18, 5 observations stranded in
      // trace 0f626c7d while the request's own trace showed only the router.
      // Field name read defensively — eve pins the lineage, not the spelling.
      const sessionInfo = ((input as unknown as { session?: Record<string, unknown> }).session ??
        {}) as Record<string, unknown>;
      // MEASURED SHAPE (2026-08-18, dumped from a live delegated turn) — the
      // root session has NO `parent`; a child's is an OBJECT, not a string:
      //   parent = { callId, rootSessionId, sessionId, turn }
      // The id lives on `parent.sessionId`. An earlier version read `parent.id`
      // and silently linked nothing, which left the specialist's whole
      // execution stranded in its own trace while every other check stayed
      // green. Read defensively, but do NOT assume a string.
      const rawParent = sessionInfo.parent as Record<string, unknown> | string | undefined;
      const parentSessionId =
        typeof rawParent === "string"
          ? rawParent
          : typeof rawParent?.sessionId === "string"
            ? rawParent.sessionId
            : typeof rawParent?.rootSessionId === "string"
              ? rawParent.rootSessionId
              : undefined;
      if (typeof sessionId === "string" && parentSessionId) {
        linkChildSession(sessionId, parentSessionId, "faq");
      }

      // Keys beginning with `eve.` are RESERVED and silently dropped — use
      // `app.` / `langfuse.`. These ride onto the AI spans as searchable metadata.
      const delegated = typeof sessionId === "string" ? childSessions.get(sessionId) : undefined;
      return {
        runtimeContext: {
          [LF.environment]: LF_ENVIRONMENT,
          // A delegated subagent's spans are grouped under the REQUEST's
          // session, not the child's, so one request is one Langfuse session.
          ...(sessionId
            ? { [LF.sessionId]: delegated?.parentSessionId ?? sessionId }
            : {}),
          "app.agent.label": delegated ? `${delegated.tool}-subagent` : "Navio-Orchestrator",
          "app.channel.kind": input.channel.kind ?? "unknown",
          "app.turn.sequence": String(input.turn.sequence),
          "app.step.purpose": delegated
            ? "Answering the delegated brief as a specialist"
            : "Choosing and executing the next action for the user's request",
          "app.action": "process_user_request",
        },
      };
    },
  },
});
