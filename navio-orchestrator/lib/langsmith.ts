// The central LangSmith module (guide Step A1, extended in A3/B2/B3/C/D/§9).
// Owns every LangSmith-related decision: region, endpoints, client
// construction, enablement gates, metadata, span filtering, run payloads.
// Both runtime entry points (agent/instrumentation.ts and
// agent/hooks/langsmith.ts) are thin consumers of it.
//
// Pure except the two file stores (traceAnchors, systemPromptStore), which
// bridge eve's SEPARATELY BUNDLED instrumentation and hook modules — module
// memory is not shared across them, so the bridge is the filesystem.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { Client } from "langsmith";

// ---------------------------------------------------------------------------
// Region + enablement (Step A1)
// ---------------------------------------------------------------------------

/** The ONE region constant. Every LangSmith URL in the project derives from
 *  it — this workspace lives in the EU region and every SDK's silent default
 *  is the US host. */
export const LANGSMITH_EU_API_URL = "https://eu.api.smith.langchain.com";

/** LangSmith's OTLP trace-ingestion endpoint for the EU region.
 *  Per the official OTel docs: the OTLP base is <host>/otel, and /v1/traces
 *  is appended when the exporter sends traces only (ours does). */
export const LANGSMITH_EU_OTEL_TRACES_URL = `${LANGSMITH_EU_API_URL}/otel/v1/traces`;

/** LangSmith is enabled only when an API key is present. Everything in this
 *  module no-ops without it, so a fresh clone runs with zero config. */
export function langsmithEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.LANGSMITH_API_KEY === "string" && env.LANGSMITH_API_KEY.trim() !== "";
}

export function projectName(
  env: NodeJS.ProcessEnv = process.env,
  fallback = "kb-agent-langsmith-starter",
): string {
  return env.LANGSMITH_PROJECT?.trim() || fallback;
}

/** `true` ships prompts/completions off-box. Off by default (privacy). */
export function recordIo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGSMITH_RECORD_IO === "true";
}

/** Whether to export the FULL eve execution graph — workflow nodes, durable
 *  steps, and network calls — alongside the AI spans, so the complete flow is
 *  inspectable in a single trace (not just AI spans + their ancestors).
 *
 *  Default: COMPLETE. Trade-off: completeness means more runs per trace (higher
 *  LangSmith trace/usage consumption). Set LANGSMITH_TRACE_COMPLETENESS=ai (or
 *  "lean"/"false") for an AI-only view with the lowest volume. */
export function traceCompleteness(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LANGSMITH_TRACE_COMPLETENESS?.trim().toLowerCase();
  return v !== "ai" && v !== "lean" && v !== "false";
}

/** COST ACCURACY. eve's AI SDK emits token usage on BOTH the outer
 *  `invoke_agent` aggregator span AND its inner per-call `chat` span, and
 *  LangSmith prices every run that carries usage — so the trace root
 *  double-counts (≈2× tokens & cost). When true (default), instrumentation
 *  strips usage from the aggregator so only the real per-call `chat` spans are
 *  priced and the trace cost is accurate. Set LANGSMITH_DEDUPE_USAGE=false to
 *  compare against the raw (inflated) numbers. */
export function dedupeUsage(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGSMITH_DEDUPE_USAGE !== "false";
}

/** Spans that AGGREGATE their children's token usage. Stripping usage from
 *  these (see instrumentation) prevents LangSmith from double-counting them
 *  against their inner `chat` calls. `invoke_agent` is the AI SDK agent-op
 *  wrapper observed on eve 0.25.3 / ai 7.x. */
export function isUsageAggregatorSpan(name: string): boolean {
  return name.startsWith("invoke_agent");
}

/** True for attribute keys that carry token usage LangSmith prices from
 *  (`gen_ai.usage.*`, `ai.usage.*`, and token-count variants). Used only to
 *  strip usage from aggregator spans, so a broad match is safe there. */
export function isUsageAttribute(key: string): boolean {
  return /usage|token/i.test(key);
}

/** The one sanctioned way to build a LangSmith SDK client: EU endpoint,
 *  explicit. Returns undefined without a key so callers stay no-op. */
export function createLangsmithClient(env: NodeJS.ProcessEnv = process.env): Client | undefined {
  if (!langsmithEnabled(env)) return undefined;
  return new Client({ apiUrl: LANGSMITH_EU_API_URL, apiKey: env.LANGSMITH_API_KEY });
}

/** Shared metadata block for every run this integration authors: model, git
 *  sha, and environment make traces filterable. Nothing injects these by
 *  default. */
export function appMetadata(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "app.model": env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "unknown",
    "app.version": env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev",
    "app.environment": env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
  };
}

// ---------------------------------------------------------------------------
// Span filter (Step A3)
// ---------------------------------------------------------------------------

/** AI spans carry `ai.` / `gen_ai.` attributes and eve's turn span carries
 *  `eve.`; eve's Workflow-SDK infrastructure spans carry none of those.
 *
 *  `complete` (see `traceCompleteness`) additionally keeps eve's structural
 *  graph spans (`workflow.*`, durable `step.*`, `fetch *`) so the full
 *  execution flow is captured and linked — not only AI spans and their
 *  ancestors. They get honest, quiet labels via `humanSpanName`. Default
 *  (2-arg calls) keeps the lean AI-only behavior. */
export function shouldExportSpan(
  name: string,
  attributeKeys: readonly string[],
  complete = false,
): boolean {
  if (name.startsWith("ai.")) return true;
  const ai = attributeKeys.some(
    (k) =>
      k.startsWith("ai.") || k.startsWith("gen_ai.") || k.startsWith("eve.") || k.startsWith("app."),
  );
  if (ai) return true;
  if (complete) {
    return (
      name.startsWith("workflow.") ||
      name.startsWith("step.") ||
      name.startsWith("fetch ")
    );
  }
  return false;
}

/** Ancestor bookkeeping for the span filter.
 *
 *  LangSmith silently DROPS any span whose parent is never ingested, and OTLP
 *  returns 200 before processing — so a naive AI-only filter exports nothing
 *  at all: every AI span's ancestor chain runs through eve's workflow spans.
 *  Fix: when an AI span ends, mark its whole ancestor chain as must-export.
 *  Children end before their parents, so ancestors see the mark in time. */
export class SpanFilterState {
  private readonly parents = new Map<string, string | undefined>();
  private readonly mustExport = new Set<string>();

  onStart(spanId: string, parentSpanId: string | undefined): void {
    this.parents.set(spanId, parentSpanId);
  }

  /** Decide whether an ended span is exported. `keep` is the AI-span verdict. */
  onEnd(spanId: string, parentSpanId: string | undefined, keep: boolean): boolean {
    if (keep) {
      let cursor = parentSpanId;
      let guard = 0;
      while (cursor && guard++ < 100) {
        this.mustExport.add(cursor);
        cursor = this.parents.get(cursor);
      }
    }
    const needed = keep || this.mustExport.has(spanId);
    this.parents.delete(spanId);
    this.mustExport.delete(spanId);
    return needed;
  }
}

// ---------------------------------------------------------------------------
// Trace anchors (Part C) — one trace per request.
//
// LangSmith converts an OTLP span into a run with the deterministic id
// `00000000-0000-0000-<spanId first 4 hex>-<spanId last 12 hex>`, and the
// root run's trace_id equals its own run id. The span filter sees every span
// locally, so it can compute the root's run id and dotted_order prefix and
// hand them to the hook — which then PRE-CREATES the trace root as the
// summary run (first writer wins; the later OTLP duplicate create is
// silently dropped, children still attach by id).
// ---------------------------------------------------------------------------

export interface TraceAnchor {
  /** LangSmith run id (and trace id) of the OTLP root span. */
  rootRunId: string;
  /** The root's dotted_order segment: `<stamp>Z<rootRunId>`. */
  rootDotted: string;
  /** Root span start in epoch ms — the created root's start_time must match
   *  the dotted_order stamp. */
  rootStartMs: number;
}

/** LangSmith's deterministic OTLP spanId → runId mapping (verified live). */
export function otelRunId(spanIdHex: string): string {
  const h = spanIdHex.toLowerCase().padStart(16, "0");
  return `00000000-0000-0000-${h.slice(0, 4)}-${h.slice(4)}`;
}

/** `YYYYMMDDTHHMMSS<micro6>Z` from epoch seconds + nanos (OTel hrTime). */
export function dottedStampFromHr(seconds: number, nanos: number): string {
  const iso = new Date(seconds * 1000).toISOString(); // 2026-07-27T12:04:43.000Z
  const base = iso.slice(0, 19).replace(/[-:]/g, "");
  return `${base}${String(Math.floor(nanos / 1000)).padStart(6, "0")}Z`;
}

/** `YYYYMMDDTHHMMSS<micro6>Z` from an epoch-milliseconds timestamp. */
export function dottedStampFromMs(epochMs: number): string {
  const secs = Math.floor(epochMs / 1000);
  return dottedStampFromHr(secs, (epochMs - secs * 1000) * 1e6);
}

function fileSafe(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Tiny file-backed store factory. Instrumentation writes, the hook reads —
 *  and they are SEPARATE module instances (eve bundles them separately), so
 *  an in-memory map alone is invisible across them. The in-memory layer is a
 *  fast path only. All I/O is best-effort: observability never breaks the
 *  agent. */
function fileStore<T>(dir: string) {
  const memory = new Map<string, T>();
  const pathFor = (sessionId: string) => `${dir}/${fileSafe(sessionId)}.json`;
  return {
    set(sessionId: string, value: T): void {
      memory.set(sessionId, value);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(pathFor(sessionId), JSON.stringify(value));
      } catch {
        // best-effort
      }
    },
    get(sessionId: string): T | undefined {
      const hit = memory.get(sessionId);
      if (hit !== undefined) return hit;
      try {
        return JSON.parse(readFileSync(pathFor(sessionId), "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    delete(sessionId: string): void {
      memory.delete(sessionId);
      try {
        unlinkSync(pathFor(sessionId));
      } catch {
        // best-effort
      }
    },
  };
}

/** Written by agent/instrumentation.ts, read + deleted by the hook. */
export const traceAnchors = fileStore<TraceAnchor>(".data/anchors");

/** Part D: the assembled system prompt for the session's current turn.
 *  gen_ai spans never carry it (eve passes it as a separate `instructions`
 *  parameter), so instrumentation captures it in events["step.started"] and
 *  the hook writes it onto the root summary run — REST runs have no OTel
 *  attribute-size limits, so it lands untruncated. */
export const systemPromptStore = fileStore<string>(".data/system-prompts");

/** Fields that attach a hook-created run inside an existing OTLP trace.
 *  `dotted_order` is REQUIRED whenever trace_id is set (400 without it). */
export interface TraceAttachment {
  id: string;
  trace_id: string;
  parent_run_id: string;
  dotted_order: string;
}

export function attachmentFor(
  anchor: TraceAnchor | undefined,
  runId: string,
  startMs: number,
): TraceAttachment | undefined {
  if (!anchor) return undefined;
  return {
    id: runId,
    trace_id: anchor.rootRunId,
    parent_run_id: anchor.rootRunId,
    dotted_order: `${anchor.rootDotted}.${dottedStampFromMs(startMs)}${runId}`,
  };
}

// ---------------------------------------------------------------------------
// Turn journal (Step B3) — one human-readable summary run per turn.
//
// The OTLP trace root is a workflow-infrastructure span: it can never carry
// inputs, outputs, or business context, so the LangSmith list would show
// "No inputs / No outputs" for every request. This journal listens to the
// stream events and, at turn end, produces ONE run answering the reader's
// questions directly: what the user asked, what the agent replied, how long
// it took, tokens/steps/tools consumed, and the outcome.
// ---------------------------------------------------------------------------

interface TurnState {
  userMessage?: string;
  reply?: string;
  startedAt?: number;
  steps: number;
  toolsUsed: string[];
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

function freshTurn(): TurnState {
  return {
    steps: 0,
    toolsUsed: [],
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };
}

/** eve's usage field names are not pinned by the docs; accept the common
 *  AI SDK spellings defensively. Wrong guesses cost nothing (0 tokens).
 *  `cached` is the subset of input tokens served from the prompt cache (billed
 *  cheaper) — used for a more accurate cost estimate. */
function usageTokens(usage: unknown): { input: number; output: number; cached: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // AI SDK v7 (Azure/OpenAI) reports prompt-cache hits under
  // `inputTokenDetails.cacheReadTokens` — verified live via `npm run cache:check`.
  // Keep the older spellings as fallbacks for other providers/versions.
  const inDetails = u.inputTokenDetails as Record<string, unknown> | undefined;
  const promptDetails = u.promptTokensDetails as Record<string, unknown> | undefined;
  return {
    input: n(u.inputTokens) || n(u.promptTokens) || n(u.input_tokens),
    output: n(u.outputTokens) || n(u.completionTokens) || n(u.output_tokens),
    cached:
      n(inDetails?.cacheReadTokens) ||
      n(u.cachedInputTokens) ||
      n(u.cacheReadInputTokens) ||
      n(u.cached_tokens) ||
      n(promptDetails?.cachedTokens),
  };
}

/** USD per 1M tokens, keyed by a substring of the model / Azure deployment name.
 *  A client-side ESTIMATE only, for immediate at-a-glance cost on the summary
 *  run — LangSmith's server-side pricing on the gen_ai llm children remains the
 *  authoritative cost. Update these as provider prices change. */
export const MODEL_PRICES: {
  match: RegExp;
  inPer1M: number;
  outPer1M: number;
  cachedInPer1M: number;
}[] = [
  { match: /gpt-4\.1-mini/i, inPer1M: 0.4, outPer1M: 1.6, cachedInPer1M: 0.1 },
  { match: /gpt-4\.1/i, inPer1M: 2, outPer1M: 8, cachedInPer1M: 0.5 },
  { match: /gpt-4o-mini/i, inPer1M: 0.15, outPer1M: 0.6, cachedInPer1M: 0.075 },
  { match: /gpt-4o/i, inPer1M: 2.5, outPer1M: 10, cachedInPer1M: 1.25 },
];

/** Rough USD estimate for a turn's token usage. Cached input is billed at the
 *  cheaper cached rate; the rest of the input at the full rate. Returns 0 when
 *  the model has no price entry — we never invent a price. */
export function estimateCostUsd(
  model: string,
  input: number,
  output: number,
  cached = 0,
): number {
  const p = MODEL_PRICES.find((e) => e.match.test(model));
  if (!p) return 0;
  const uncachedInput = Math.max(0, input - cached);
  return (uncachedInput * p.inPer1M + cached * p.cachedInPer1M + output * p.outPer1M) / 1_000_000;
}

export interface SummaryRunPayload {
  id?: string;
  trace_id?: string;
  parent_run_id?: string;
  dotted_order?: string;
  name: string;
  run_type: "chain";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  start_time: number;
  end_time: number;
  project_name: string;
  extra: { metadata: Record<string, string> };
}

export class TurnJournal {
  private readonly turns = new Map<string, TurnState>();

  private turn(sessionId: string): TurnState {
    let t = this.turns.get(sessionId);
    if (!t) {
      t = freshTurn();
      this.turns.set(sessionId, t);
    }
    return t;
  }

  record(
    sessionId: string,
    type: string,
    data: Record<string, unknown> | undefined,
    now: number,
  ): void {
    const t = this.turn(sessionId);
    switch (type) {
      case "message.received": {
        // A new user message starts a new journal entry for this session.
        const fresh = freshTurn();
        fresh.userMessage = typeof data?.message === "string" ? data.message : undefined;
        fresh.startedAt = now;
        this.turns.set(sessionId, fresh);
        break;
      }
      case "step.completed": {
        t.steps += 1;
        const { input, output, cached } = usageTokens(data?.usage);
        t.inputTokens += input;
        t.outputTokens += output;
        t.cachedTokens += cached;
        break;
      }
      case "action.result": {
        const result = data?.result as { toolName?: string; isError?: boolean } | undefined;
        if (result?.toolName) t.toolsUsed.push(result.toolName);
        if (result?.isError) t.toolErrors += 1;
        break;
      }
      case "message.completed": {
        // Fires per assistant text block; the last one is the reply. Field
        // spelling differs across eve versions — accept the known shapes.
        const text = (data?.text ?? data?.message ?? data?.content) as unknown;
        if (typeof text === "string" && text.trim() !== "") t.reply = text;
        break;
      }
    }
  }

  /** Build the summary run for a finished turn and clear its state.
   *  Returns undefined when nothing was journaled (e.g. process restarted
   *  mid-turn) — better no run than a misleading empty one. */
  finalize(args: {
    sessionId: string;
    outcome: "answered" | "failed";
    agentName: string;
    channelKind?: string;
    project: string;
    recordContent: boolean;
    now: number;
    anchor?: TraceAnchor;
    systemPrompt?: string;
  }): SummaryRunPayload | undefined {
    const t = this.turns.get(args.sessionId);
    this.turns.delete(args.sessionId);
    if (!t || (t.userMessage === undefined && t.steps === 0)) return undefined;

    // With an anchor, the summary BECOMES the trace root: we create the root
    // run (same id/dotted_order the OTLP root span will map to) minutes
    // before OTLP ingestion. LangSmith rejects the later OTLP root create as
    // a duplicate, but all its children attach to ours by id.
    const attach = args.anchor
      ? {
          id: args.anchor.rootRunId,
          trace_id: args.anchor.rootRunId,
          dotted_order: args.anchor.rootDotted,
        }
      : undefined;

    const redacted = "[content capture off — set LANGSMITH_RECORD_IO=true]";
    const userMessage = args.recordContent ? (t.userMessage ?? "") : redacted;
    const reply = args.recordContent ? (t.reply ?? "") : redacted;
    // Names must not leak user text when content capture is off (§9).
    const headline = args.recordContent
      ? `"${(t.userMessage ?? "…").slice(0, 60)}${(t.userMessage?.length ?? 0) > 60 ? "…" : ""}"`
      : `(${t.steps} steps)`;
    const start = args.anchor?.rootStartMs ?? t.startedAt ?? args.now;

    return {
      ...(attach ?? {}),
      name: `Customer Request: ${headline}`,
      run_type: "chain",
      inputs: {
        user_message: userMessage,
        ...(args.recordContent && args.systemPrompt
          ? { system_prompt: args.systemPrompt }
          : {}),
      },
      outputs: { agent_reply: reply, outcome: args.outcome },
      ...(args.outcome === "failed"
        ? { error: "Turn failed — see the matching failure run for the full story." }
        : {}),
      start_time: start,
      end_time: args.now,
      project_name: args.project,
      extra: {
        metadata: {
          ...appMetadata(),
          "app.outcome": args.outcome,
          "app.duration_ms": String(args.now - start),
          "app.model_steps": String(t.steps),
          "app.tools_used": t.toolsUsed.join(", ") || "none",
          "app.tool_errors": String(t.toolErrors),
          // Immediate token visibility; dollar cost rolls up server-side from
          // the OTLP llm children — never set native usage fields here (§8.2).
          "app.tokens.input": String(t.inputTokens),
          "app.tokens.output": String(t.outputTokens),
          "app.tokens.cached": String(t.cachedTokens),
          "app.tokens.total": String(t.inputTokens + t.outputTokens),
          // At-a-glance ESTIMATE for immediate cost visibility (server-side
          // pricing on the llm children stays authoritative; metadata field, so
          // the two never double-count).
          "app.cost.estimate_usd": estimateCostUsd(
            appMetadata()["app.model"] ?? "unknown",
            t.inputTokens,
            t.outputTokens,
            t.cachedTokens,
          ).toFixed(6),
          "app.agent": args.agentName,
          "app.channel.kind": args.channelKind ?? "unknown",
          "eve.session.id": args.sessionId,
          thread_id: args.sessionId, // LangSmith groups traces into threads by this
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Failure payloads (Step B2 + §9.4) — failures are stories, not stack traces.
// ---------------------------------------------------------------------------

export type FailureKind = "tool" | "step" | "turn" | "session";

export interface ToolErrorStory {
  match: RegExp;
  /** Short headline for the run name, e.g. "Cannot divide by zero". */
  headline: string;
  error_type:
    | "invalid_input"
    | "upstream_unavailable"
    | "timeout"
    | "permission_denied"
    | "unexpected";
  user_friendly_message: string;
  recommended_action: string;
}

export interface ToolStory {
  /** Human display name, e.g. "Calculator Tool". */
  human: string;
  /** The business action this tool performs, stable across renames. */
  action: string;
  /** What a user is typically trying to do when this tool runs. */
  user_goal: string;
  errors: ToolErrorStory[];
}

/** Per-tool story table: extend as you add tools (§9.3). This starter agent
 *  ships no tools; calculate_division is the guide's demo tool, temporarily
 *  added while verifying Part B live. */
export const TOOL_STORIES: Record<string, ToolStory> = {
  calculate_division: {
    human: "Calculator Tool",
    action: "calculate_result",
    user_goal: "Divide two numbers",
    errors: [
      {
        match: /division by zero/i,
        headline: "Cannot divide by zero",
        error_type: "invalid_input",
        user_friendly_message:
          "The calculation could not be completed because the second number was zero.",
        recommended_action: "Ask the user for a non-zero divisor and retry.",
      },
    ],
  },
};

export function toolStory(toolName: string): ToolStory {
  return (
    TOOL_STORIES[toolName] ?? {
      human: `${toolName} Tool`,
      action: toolName,
      user_goal: "unknown",
      errors: [],
    }
  );
}

/** eve failure payloads are `{ code, message }` (step/turn/session events) or
 *  a raw value (a thrown tool's output). Normalize both. */
export function failureMessage(
  data: unknown,
  fallback: string,
): { message: string; code?: string } {
  if (typeof data === "string" && data.trim() !== "") return { message: data };
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  return {
    message: typeof obj?.message === "string" ? obj.message : fallback,
    code: typeof obj?.code === "string" ? obj.code : undefined,
  };
}

export interface FailureRunPayload {
  id?: string;
  trace_id?: string;
  parent_run_id?: string;
  dotted_order?: string;
  name: string;
  run_type: "chain";
  inputs: Record<string, unknown>;
  error: string;
  start_time: number;
  end_time: number;
  project_name: string;
  extra: { metadata: Record<string, string> };
}

const KIND_LABEL: Record<FailureKind, string> = {
  tool: "Tool Call",
  step: "Agent Step",
  turn: "Agent Turn",
  session: "Agent Session",
};

/** Shape one eve failure event as a LangSmith run (Client.createRun payload).
 *  The run NAME tells the story in plain language; `error` keeps the raw
 *  technical message for developers; metadata answers what the user was
 *  doing, which step failed, why, and what to do next (§9.4). */
export function failureRunPayload(args: {
  kind: FailureKind;
  subject: string;
  data: unknown;
  sessionId: string;
  agentName: string;
  channelKind?: string;
  project: string;
  now: number;
  attach?: TraceAttachment;
}): FailureRunPayload {
  const { message, code } = failureMessage(args.data, `eve ${args.kind} failed`);

  const story = args.kind === "tool" ? toolStory(args.subject) : undefined;
  const errorStory = story?.errors.find((e) => e.match.test(message));
  const humanWho = story ? story.human : `${KIND_LABEL[args.kind]} (${args.subject})`;
  const headline = errorStory?.headline ?? message;

  return {
    ...(args.attach ?? {}),
    name: `${humanWho} Failed: ${headline}`.slice(0, 140),
    run_type: "chain",
    inputs: { subject: args.subject },
    error: code ? `[${code}] ${message}` : message,
    start_time: args.now,
    end_time: args.now,
    project_name: args.project,
    extra: {
      metadata: {
        ...appMetadata(),
        action: story?.action ?? `${args.kind}_execution`,
        tool: args.kind === "tool" ? args.subject : "none",
        // Controlled vocabulary — dashboards group by it.
        error_type: errorStory?.error_type ?? "unexpected",
        user_friendly_message:
          errorStory?.user_friendly_message ??
          `The agent could not complete this ${KIND_LABEL[args.kind].toLowerCase()}: ${message}`,
        failed_step: args.kind === "tool" ? `Calling ${humanWho}` : KIND_LABEL[args.kind],
        user_goal: story?.user_goal ?? "unknown",
        recommended_action:
          errorStory?.recommended_action ??
          "Inspect the raw error and the surrounding trace, then retry or escalate.",
        "app.agent": args.agentName,
        "app.channel.kind": args.channelKind ?? "unknown",
        "eve.session.id": args.sessionId,
        "failure.kind": args.kind,
        "failure.subject": args.subject,
        thread_id: args.sessionId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Export-time span renaming (§9.2) — names only, attributes untouched.
// Run typing, token extraction, and tree stitching all key off ATTRIBUTES,
// so renaming is safe. Tool runs are the one exception (LangSmith names them
// from the gen_ai tool attributes) — fix tool names at the source (§9.3).
// ---------------------------------------------------------------------------

export function humanSpanName(name: string): string {
  // Trace root: the whole customer interaction.
  if (name === "workflow.route.flow") return "Customer Request Processing";
  // eve's turn span: one question-answer cycle.
  if (name === "ai.eve.turn") return "Agent Turn: Understanding & Responding";
  // AI SDK v7 gen_ai spans (names observed live on eve 0.25.3 / ai 7.0.34).
  const invokeAgent = name.match(/^invoke_agent\s+(.+)$/);
  if (invokeAgent) return `Agent Reasoning (${invokeAgent[1]})`;
  const chat = name.match(/^chat\s+(.+)$/);
  if (chat) return `Generating Response (${chat[1]})`;
  const step = name.match(/^step (\d+)$/);
  if (step) return `Attempt ${step[1]}: Model Call & Tool Selection`;
  const tool = name.match(/^execute_tool\s+(.+)$/);
  if (tool) return `Calling ${toolStory(tool[1]).human}`;
  // Bare tool-call span (AI SDK names it after the tool in some shapes).
  if (TOOL_STORIES[name]) return `Calling ${TOOL_STORIES[name].human}`;
  // Workflow ancestors kept only for tree integrity — honest, quiet labels.
  if (name.startsWith("workflow.execute")) return "Agent Run (infrastructure)";
  if (name.startsWith("step.execute")) return "Processing Step (infrastructure)";
  if (name.startsWith("workflow.stream")) return "Streaming Response (infrastructure)";
  if (name.startsWith("workflow.")) return "Agent Session (infrastructure)";
  if (name.startsWith("fetch ")) return "Network Call (infrastructure)";
  return name;
}
