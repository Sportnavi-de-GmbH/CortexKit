// The central Langfuse module — every Langfuse decision lives here, and the
// two runtime entry points (agent/instrumentation.ts, agent/hooks/langfuse.ts)
// are thin consumers of it.
//
// This replaced the LangSmith tracing integration on 2026-08-12. LangSmith
// remains ONLY in the eval pipeline (lib/eval/*, scripts/*eval*), which imports
// the `langsmith` package directly — nothing in the tracing path touches it.
//
// WHY OTLP AND NOT THE LANGFUSE SDK
// Langfuse ingests plain OTLP, and eve's AI SDK v7 telemetry already emits
// gen_ai.* spans, which Langfuse maps natively (model, tokens, cost). So this
// integration points an OTLP exporter at Langfuse and adds `langfuse.*`
// attributes. No Langfuse SDK, no business-logic changes.
// The `/api/public/ingestion` REST endpoint is documented as LEGACY in the
// instance's own OpenAPI spec ("Please use the OpenTelemetry endpoint") —
// which is why even failures are emitted as OTel spans, not posted to it.
//
// Contract, verified against langfuse.com/integrations/native/opentelemetry
// and the running instance's OpenAPI spec (v4.6.0):
//   POST <host>/api/public/otel/v1/traces
//   Authorization: Basic base64("<public key>:<secret key>")
//   x-langfuse-ingestion-version: 4   ← real-time v4 ingestion. Without it,
//                                       traces can lag up to ~10 minutes.
//
// INVARIANTS
//   * missing credentials ⇒ complete no-op (a fresh clone runs credential-free)
//   * observability never throws and never blocks a turn
//   * content capture is off unless LANGFUSE_RECORD_IO=true
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Endpoint, auth, enablement
// ---------------------------------------------------------------------------

/** Signal-specific OTLP path. The OTLP base is `<host>/api/public/otel`;
 *  `/v1/traces` is appended when the exporter sends traces only (ours does). */
export const LANGFUSE_OTEL_TRACES_PATH = "/api/public/otel/v1/traces";

/** REST base — used by scripts/verify-langfuse.ts to read traces back. */
export const LANGFUSE_PUBLIC_API_PATH = "/api/public";

/** Base URL of the Langfuse instance, without a trailing slash.
 *  `LANGFUSE_BASE_URL` is the v4 spelling; `LANGFUSE_HOST` is also accepted
 *  because the JS SDK and several docs pages use it. "" = not configured. */
export function langfuseBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST ?? "";
  return raw.trim().replace(/\/+$/, "");
}

/** Enabled only when host + BOTH keys are present. Anything less counts as
 *  "not configured", so every Langfuse surface stays a silent no-op. */
export function langfuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    langfuseBaseUrl(env) !== "" &&
    (env.LANGFUSE_PUBLIC_KEY ?? "").trim() !== "" &&
    (env.LANGFUSE_SECRET_KEY ?? "").trim() !== ""
  );
}

export function langfuseTracesUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${langfuseBaseUrl(env)}${LANGFUSE_OTEL_TRACES_PATH}`;
}

/** `Basic base64(publicKey:secretKey)` — Langfuse's documented OTLP auth. */
export function langfuseAuthHeader(env: NodeJS.ProcessEnv = process.env): string {
  const pk = (env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const sk = (env.LANGFUSE_SECRET_KEY ?? "").trim();
  return `Basic ${Buffer.from(`${pk}:${sk}`, "utf8").toString("base64")}`;
}

/** Headers for the OTLP exporter and the REST reads alike. */
export function langfuseHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    Authorization: langfuseAuthHeader(env),
    "x-langfuse-ingestion-version": "4",
  };
}

/** Langfuse environment tag. Documented constraint: `^(?!langfuse)[a-z0-9-_]+$`,
 *  max 40 chars — an invalid value makes Langfuse REJECT the span, so this
 *  normalizes rather than passes through. */
export function langfuseEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LANGFUSE_TRACING_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? "development";
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
  if (cleaned === "" || cleaned.startsWith("langfuse")) return "development";
  return cleaned;
}

/** `true` ships prompts and completions to Langfuse. Off by default: this is
 *  a public, anonymous widget and visitor text is personal data. */
export function langfuseRecordIo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_RECORD_IO === "true";
}

/** `true` puts the ENTIRE assembled system prompt (~16.7k tokens, the whole
 *  knowledge base) on the summary observation. Off by default — it replays on
 *  every turn and would dominate trace storage. The KB *fingerprint* is always
 *  recorded, which is what you actually need to answer "which KB version
 *  produced this answer". */
export function langfuseRecordSystemPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_RECORD_SYSTEM_PROMPT === "true" && langfuseRecordIo(env);
}

/** Whether to export eve's structural graph spans (workflow nodes, durable
 *  steps, transport fetches) alongside the AI spans.
 *
 *  DEFAULT: OFF — measured, not assumed. With it on, one FAQ turn produced
 *  **112 observations**, of which 89 were eve's internal transport chatter
 *  (55 `fetch *`, 34 `workflow.stream.*`). That is a 14× cost multiplier on a
 *  per-observation-priced backend, and it buries the spans a reader wants.
 *
 *  Set LANGFUSE_TRACE_COMPLETENESS=complete when debugging eve itself. */
export function traceCompleteness(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LANGFUSE_TRACE_COMPLETENESS?.trim().toLowerCase();
  return v === "complete" || v === "full" || v === "true";
}

/** COST ACCURACY. eve's AI SDK emits token usage on BOTH the outer
 *  `invoke_agent` aggregator span AND its inner per-call `chat` span. Langfuse
 *  prices every observation that carries usage, so leaving both in place
 *  double-counts tokens and cost (~2×). */
export function dedupeUsage(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_DEDUPE_USAGE !== "false";
}

/** Spans that AGGREGATE their children's token usage. */
export function isUsageAggregatorSpan(name: string): boolean {
  return name.startsWith("invoke_agent");
}

/** Attribute keys carrying token usage Langfuse prices from. Used ONLY to
 *  strip usage off aggregator spans, so a broad match is safe here. */
export function isUsageAttribute(key: string): boolean {
  return /usage|token/i.test(key);
}

// ---------------------------------------------------------------------------
// Who this agent is
//
// A reader of a trace must be able to tell WHICH Navio agent produced it
// without knowing the repo. Navio has three (KB/FAQ, Partner, Menu) plus the
// multi-agent orchestrator, each with its own Langfuse project — but a trace
// should still say so on its own.
// ---------------------------------------------------------------------------

/** Short label used in trace names. */
export const KB_AGENT_LABEL = "KB-Agent";

/** What this agent is, in one line, for anyone reading a trace cold. */
export const KB_AGENT_ROLE =
  "Navio FAQ/KB agent — answers Sportnavi product, tariff, contract and check-in questions from a knowledge base embedded in its system prompt";

/** The knowledge architecture, stated explicitly because its most surprising
 *  property is a NEGATIVE: there is no retrieval and there are no tools, so a
 *  reader must not go looking for retrieval spans that will never exist. */
export const KB_KNOWLEDGE_MODE = "prompt-embedded (no retrieval, no vector store, no tools)";
export const KB_KNOWLEDGE_SOURCE = "agent/instructions.md → === KNOWLEDGE BASE === block";
export const KB_TOOLS_AVAILABLE = "0 (all 11 eve built-ins disabled by design)";

export function appMetadata(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "app.model": env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "unknown",
    "app.version": env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev",
    "app.environment": langfuseEnvironment(env),
  };
}

// ---------------------------------------------------------------------------
// Langfuse attribute names (the mapping table, in one place)
//
// Source: langfuse.com/docs/opentelemetry/get-started — "these specific
// attributes always take precedence over generic OpenTelemetry conventions".
// Confirmed live against this workspace's own eve→Langfuse traces.
// ---------------------------------------------------------------------------

export const LF = {
  sessionId: "langfuse.session.id",
  userId: "langfuse.user.id",
  environment: "langfuse.environment",
  traceName: "langfuse.trace.name",
  traceInput: "langfuse.trace.input",
  traceOutput: "langfuse.trace.output",
  traceTags: "langfuse.trace.tags",
  traceMetadataPrefix: "langfuse.trace.metadata.",
  observationType: "langfuse.observation.type",
  observationInput: "langfuse.observation.input",
  observationOutput: "langfuse.observation.output",
  observationLevel: "langfuse.observation.level",
  observationStatusMessage: "langfuse.observation.status_message",
} as const;

/** Trace-level metadata: these show on the TRACE itself, not just on one
 *  observation, which is what makes the trace list scannable. */
export function traceMetadata(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [`${LF.traceMetadataPrefix}${k}`, v]),
  );
}

/** Observation type for a span, or undefined to let Langfuse infer it.
 *
 *  DELIBERATELY CONSERVATIVE: Langfuse already types gen_ai spans as
 *  GENERATION from their attributes, and that inference is what drives cost
 *  lookup — mistyping a model call as a plain span silently loses its cost.
 *  So we only ADD what inference cannot know. */
export function langfuseObservationType(spanName: string): string | undefined {
  if (spanName === "ai.eve.turn") return "agent";
  if (spanName.startsWith("execute_tool") || spanName.startsWith("ai.toolCall")) return "tool";
  return undefined;
}

// ---------------------------------------------------------------------------
// Span naming — the trace has to read like a story
//
// Framework names (`workflow.route.flow`, `invoke_agent gpt-4o-mini`,
// `step 1`) describe eve's plumbing, not what happened to the visitor. These
// names describe the WORK, stay stable (so Langfuse can group, filter and
// evaluate by name), and never interpolate the model or the user's text.
// ---------------------------------------------------------------------------

/** The KB agent's real execution flow, one name per stage. Named after the
 *  WORK, so the tree reads as a sentence:
 *
 *    visitor-request → answer-question → apply-knowledge-base
 *                    → compose-answer → generate-answer   (+ answer-delivered)
 *
 *  Nothing here is invented: each maps 1:1 onto a span eve/the AI SDK already
 *  emits for this agent. There is no retrieval stage because this agent does
 *  no retrieval — inventing one would be theatre. */
export const SPAN = {
  /** eve `workflow.route.flow` — the whole visitor request. Trace root. */
  request: "visitor-request",
  /** eve `ai.eve.turn` — one question → answer cycle. */
  turn: "answer-question",
  /** AI SDK `invoke_agent` — loads the KB into context and drives the call. */
  applyKnowledge: "apply-knowledge-base",
  /** AI SDK `step N` — one attempt at producing the answer. */
  compose: "compose-answer",
  /** AI SDK `chat` — the billed Azure call. GENERATION. */
  generate: "generate-answer",
  /** The hook's readable per-turn summary. */
  summary: "answer-delivered",
} as const;

export function humanSpanName(name: string): string {
  if (name === "workflow.route.flow") return SPAN.request;
  if (name === "ai.eve.turn") return SPAN.turn;
  if (name.startsWith("invoke_agent")) return SPAN.applyKnowledge;
  if (name.startsWith("chat")) return SPAN.generate;
  if (/^step \d+$/.test(name)) return SPAN.compose;
  const tool = name.match(/^execute_tool\s+(.+)$/);
  if (tool) return `tool:${tool[1]}`;
  return name;
}

/** One line per stage explaining what it does and why it exists, stamped onto
 *  the observation so a reader never has to open the source to interpret a
 *  node. Keyed by the RENAMED span name. */
export const STEP_PURPOSE: Record<string, string> = {
  [SPAN.request]:
    "The complete visitor request, from the widget's HTTP call to the delivered answer.",
  [SPAN.turn]:
    "One question → answer cycle. Everything the agent did in response to this single message.",
  [SPAN.applyKnowledge]:
    "Loads the Sportnavi knowledge base into the model's context (it lives in the system prompt — there is no retrieval step) and drives the model call.",
  [SPAN.compose]:
    "One attempt at composing the answer: assemble instructions + conversation history, call the model, collect the reply.",
  [SPAN.generate]:
    "The billed Azure OpenAI call that writes the answer. Carries model, token usage and cost.",
  [SPAN.summary]:
    "The outcome of the turn: what the visitor asked, what Navio replied, and what it cost.",
};

/** Spans that carry MEANING for a reader, decided from the name alone.
 *
 *  Name-only is deliberate: the decision has to be answerable for a span's
 *  ANCESTORS while they are still open (see instrumentation's re-parenting),
 *  and a span's name is fixed at creation while its attributes are not.
 *
 *  Everything else — `workflow.execute`, `workflow.stream.*`, `step.execute`,
 *  `step.hydrate`, `hook.resume`, `fetch *` — is eve's runtime plumbing. It is
 *  dropped, and its children are re-parented onto the nearest meaningful
 *  ancestor so the tree stays connected. */
export function isMeaningfulSpanName(name: string): boolean {
  if (name === "workflow.route.flow") return true; // the trace root
  if (name.startsWith("ai.")) return true; // ai.eve.turn, ai.streamText, ai.toolCall
  if (name.startsWith("invoke_agent") || name.startsWith("chat")) return true;
  if (/^step \d+$/.test(name)) return true; // AI SDK step, NOT eve's `step.execute`
  if (name.startsWith("execute_tool")) return true;
  // Our own spans.
  if (name === SPAN.summary || name.startsWith("failure:")) return true;
  return false;
}

/** Whether an ended span is exported at all. */
export function shouldExportSpan(
  name: string,
  attributeKeys: readonly string[],
  complete = false,
): boolean {
  if (complete) return true;
  if (isMeaningfulSpanName(name)) return true;
  // Safety net: anything we deliberately annotated is worth keeping.
  return attributeKeys.some((k) => k.startsWith("app.") || k.startsWith("langfuse."));
}

// ---------------------------------------------------------------------------
// Knowledge provenance
//
// The FAQ agent has no retrieval, so "which knowledge source was used" cannot
// be answered by a retriever span — the answer is "the system prompt", and the
// only useful question is WHICH VERSION of it. A digest answers that: two
// traces with the same digest saw byte-identical knowledge.
// ---------------------------------------------------------------------------

export interface KnowledgeSource {
  mode: string;
  source: string;
  /** sha256 prefix — changes iff the KB text changed. */
  digest: string;
  chars: string;
  approxTokens: string;
  /** The `=== SECTION ===` headers actually present in the prompt. */
  sections: string;
}

export function knowledgeSource(systemPrompt: string | undefined): KnowledgeSource | undefined {
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return undefined;
  const sections = [...systemPrompt.matchAll(/^===\s*(.+?)\s*===$/gm)].map((m) => m[1]);
  return {
    mode: KB_KNOWLEDGE_MODE,
    source: KB_KNOWLEDGE_SOURCE,
    digest: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12),
    chars: String(systemPrompt.length),
    // ~4 chars/token is the usual English/German approximation. Labelled
    // "approx" so nobody mistakes it for the billed number, which is on the
    // generation observation.
    approxTokens: String(Math.round(systemPrompt.length / 4)),
    sections: sections.join(" · ") || "(no === SECTION === headers found)",
  };
}

// ---------------------------------------------------------------------------
// Cross-bundle stores
//
// eve bundles agent/instrumentation.ts and agent/hooks/*.ts SEPARATELY, so
// module memory is not shared between them. The bridge is the filesystem.
// All I/O is best-effort: observability never breaks the agent.
// ---------------------------------------------------------------------------

function fileSafe(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

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

/** Where a session's current trace lives, so the hook can attach its spans to
 *  the SAME trace the OTLP exporter is filling. */
export interface TraceRef {
  /** 32 hex chars. */
  traceId: string;
  /** 16 hex chars — the span the hook's spans should hang under. */
  rootSpanId: string;
}

export const traceRefs = fileStore<TraceRef>(".data/langfuse-traces");

/** The assembled system prompt for the session's current turn. gen_ai spans
 *  never carry it (eve passes `instructions` as a separate parameter), so
 *  instrumentation captures it in events["step.started"]. It is the agent's
 *  entire knowledge source — see knowledgeSource(). */
export const systemPromptStore = fileStore<string>(".data/system-prompts");

/** What the visitor asked and what Navio replied, for the CURRENT turn.
 *
 *  Written by the hook (which is the only place that sees `message.received`
 *  and `message.completed`) and read by the span processor, which otherwise
 *  has no idea what the conversation was about. Without this bridge, eve's
 *  own spans export with `input: null, output: null` — measured on a real
 *  trace, three of six observations were completely empty, including the
 *  trace root a reviewer opens first. */
export interface TurnIo {
  question?: string;
  reply?: string;
}

export const turnIoStore = fileStore<TurnIo>(".data/turn-io");

/**
 * (session, turn) → the trace that answered it. THE bridge for user feedback.
 *
 * The browser knows which answer it is reacting to (`message.metadata.turnId`)
 * but never sees a Langfuse trace id, and must not: trace ids are only
 * meaningful together with the project credentials, which are server-only. So
 * the server resolves the trace, and the client sends nothing but the turn.
 *
 * ⚠ SCOPE OF THIS STORE. It is process-local (memory + `.data/`), which is
 * exactly right in dev and on a warm serverless instance, and NOT sufficient in
 * production: a feedback POST can land on a different instance than the one
 * that ran the turn, whose `.data/` is empty and ephemeral. That is not a bug
 * to paper over — `resolveFeedbackTarget()` degrades to a SESSION-level score
 * (Langfuse accepts `sessionId` as a score target) so the feedback is still
 * recorded, just at lower precision, and the turn id is preserved in the score
 * metadata either way. Making it trace-precise in production means moving this
 * one map to a shared KV; nothing else changes.
 */
export interface FeedbackRef {
  traceId: string;
  /** The `answer-delivered` summary observation, for future per-observation
   *  scoring. Recorded now so the option stays open without a data migration. */
  summaryObservationId?: string;
}

const feedbackRefStore = fileStore<FeedbackRef>(".data/feedback-refs");

/** One key per answered turn. */
function feedbackKey(sessionId: string, turnId: string): string {
  return `${sessionId}__${turnId}`;
}

export const feedbackRefs = {
  set(sessionId: string, turnId: string, ref: FeedbackRef): void {
    feedbackRefStore.set(feedbackKey(sessionId, turnId), ref);
  },
  get(sessionId: string, turnId: string): FeedbackRef | undefined {
    return feedbackRefStore.get(feedbackKey(sessionId, turnId));
  },
};

/**
 * Marks a (target kind, object id) as already pushed to the Langfuse
 * Annotation Queue, so a retry or a double-click of the same 👎 never creates
 * a second PENDING item for the same trace/session.
 *
 * No TTL: "already queued" should stay true until a human clears the item in
 * Langfuse, not expire on its own — an item that quietly re-queues itself
 * after a cache eviction would be confusing, not helpful.
 */
const queuedMarkerStore = fileStore<{ queuedAt: string }>(".data/annotation-queue-markers");

export const queuedMarkers = {
  has(key: string): boolean {
    return queuedMarkerStore.get(key) !== undefined;
  },
  set(key: string): void {
    queuedMarkerStore.set(key, { queuedAt: new Date().toISOString() });
  },
};

/** Attribute values big enough to make an observation unreadable. The AI SDK
 *  puts the whole message history — including the 73 KB knowledge base — on
 *  `ai.prompt.messages` as escaped JSON; on a real trace that was a single
 *  79,634-character attribute. Wherever we supply a readable input of our own,
 *  these are dropped. Matching on SIZE rather than on key names is deliberate:
 *  it keeps working when the AI SDK renames its attributes. */
export const MAX_ATTRIBUTE_CHARS = 4_000;

/** Only the PROMPT side is dropped. Stripping by size alone also removed the
 *  attributes Langfuse derives an observation's OUTPUT from, which silently
 *  emptied the output of three spans (measured 2026-08-13) — the answer text
 *  is worth keeping at any size, the replayed 73 KB prompt is not. */
export function isOversizedAttribute(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length <= MAX_ATTRIBUTE_CHARS) return false;
  if (/response|completion|output/i.test(key)) return false;
  return /prompt|input|messages/i.test(key);
}

/** What the model was actually given, as something a human can read.
 *
 *  The KB agent's entire "retrieval" is the system prompt, so a model call
 *  whose input is only the user's message hides the thing that produced the
 *  answer. This puts the real context on the generation, structured rather
 *  than as one escaped blob. */
export function generationInput(args: {
  systemPrompt?: string;
  question?: string;
  recordContent: boolean;
}): string {
  const kb = knowledgeSource(args.systemPrompt);
  return JSON.stringify(
    {
      user_question: args.recordContent ? (args.question ?? "(not captured)") : REDACTED,
      knowledge_base: kb
        ? {
            source: kb.source,
            mode: kb.mode,
            version_digest: kb.digest,
            size_chars: Number(kb.chars),
            approx_tokens: Number(kb.approxTokens),
            sections: kb.sections.split(" · "),
          }
        : "(system prompt not captured for this turn)",
      system_prompt: args.recordContent
        ? (args.systemPrompt ?? "(not captured)")
        : REDACTED,
    },
    null,
    2,
  );
}

/** The same context, minus the full prompt text — for the wrapper spans, where
 *  repeating 73 KB on every level would bury the trace. */
export function contextSummary(args: {
  systemPrompt?: string;
  question?: string;
  recordContent: boolean;
}): string {
  const kb = knowledgeSource(args.systemPrompt);
  return JSON.stringify(
    {
      user_question: args.recordContent ? (args.question ?? "(not captured)") : REDACTED,
      knowledge_base: kb
        ? `${kb.source} · ${kb.chars} chars · ~${kb.approxTokens} tokens · digest ${kb.digest}`
        : "(system prompt not captured for this turn)",
      retrieval: "none — the knowledge base is already in the prompt",
      tools_available: KB_TOOLS_AVAILABLE,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Session propagation
//
// Langfuse groups traces into Sessions from `langfuse.session.id`, and the
// docs are explicit that the attribute should be present on ALL spans of a
// trace. eve puts the session id only on `ai.eve.turn`.
// ---------------------------------------------------------------------------

const MAX_TRACKED_TRACES = 2000;
const sessionByTraceId = new Map<string, string>();

export function rememberSession(traceId: string, sessionId: string): void {
  if (sessionByTraceId.size >= MAX_TRACKED_TRACES) {
    const oldest = sessionByTraceId.keys().next();
    if (!oldest.done) sessionByTraceId.delete(oldest.value);
  }
  sessionByTraceId.set(traceId, sessionId);
}

export function sessionForTrace(traceId: string): string | undefined {
  return sessionByTraceId.get(traceId);
}

export function forgetTrace(traceId: string): void {
  sessionByTraceId.delete(traceId);
}

// ---------------------------------------------------------------------------
// Failure stories — a failure is a story, not a stack trace.
// ---------------------------------------------------------------------------

export type FailureKind = "tool" | "step" | "turn" | "session";

export interface ToolErrorStory {
  match: RegExp;
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
  human: string;
  action: string;
  user_goal: string;
  errors: ToolErrorStory[];
}

/** Per-tool story table. The KB agent ships ZERO tools by design, so this is
 *  empty on purpose — it is the extension point if that ever changes. */
export const TOOL_STORIES: Record<string, ToolStory> = {};

export function toolStory(toolName: string): ToolStory {
  return (
    TOOL_STORIES[toolName] ?? { human: toolName, action: toolName, user_goal: "unknown", errors: [] }
  );
}

/** Recognises the failures this agent actually hits, so the trace explains the
 *  cause instead of only quoting the provider. Extend as new ones appear. */
export const FAILURE_PATTERNS: {
  match: RegExp;
  error_type: ToolErrorStory["error_type"];
  cause: string;
  recommended_action: string;
}[] = [
  {
    match: /invalid subscription key|access denied|401/i,
    error_type: "permission_denied",
    cause: "Azure OpenAI rejected the credentials (wrong key, or key/endpoint mismatch).",
    recommended_action:
      "Check AZURE_AI_CHATBOT_API_KEY and AZURE_AI_CHATBOT_OPENAI_ENDPOINT for this environment.",
  },
  {
    match: /rate limit|429|too many requests/i,
    error_type: "upstream_unavailable",
    cause: "Azure returned 429 — the deployment's tokens-per-minute allowance was exceeded.",
    recommended_action:
      "Check the Azure TPM ceiling against the ~16.7k-token prompt replayed on every turn.",
  },
  {
    match: /timeout|timed out|ETIMEDOUT|aborted/i,
    error_type: "timeout",
    cause: "The model call did not return in time.",
    recommended_action: "Check Azure health and the route's maxDuration.",
  },
];

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

const KIND_LABEL: Record<FailureKind, string> = {
  tool: "tool",
  step: "agent-step",
  turn: "agent-turn",
  session: "agent-session",
};

export interface FailureSpan {
  /** Stable, action-oriented, NOT interpolated with the error text. */
  name: string;
  statusMessage: string;
  attributes: Record<string, string>;
}

/** Shape one eve failure event as an OTel span for Langfuse. */
export function failureSpan(args: {
  kind: FailureKind;
  subject: string;
  data: unknown;
  sessionId: string;
  agentName: string;
  channelKind?: string;
  /** What the visitor asked, so the failure says who it happened to. */
  question?: string;
  recordContent?: boolean;
  env?: NodeJS.ProcessEnv;
}): FailureSpan {
  const env = args.env ?? process.env;
  const { message, code } = failureMessage(args.data, `eve ${args.kind} failed`);
  const story = args.kind === "tool" ? toolStory(args.subject) : undefined;
  const known = FAILURE_PATTERNS.find((p) => p.match.test(message));
  const recordContent = args.recordContent ?? langfuseRecordIo(env);
  const impact =
    args.kind === "session"
      ? "The visitor's session ended without an answer."
      : "The visitor did not get an answer to this message.";

  return {
    // Stable name so Langfuse can group and chart failures. The variable part
    // (the message) goes to statusMessage, never into the name.
    name: `failure:${KIND_LABEL[args.kind]}`,
    statusMessage: code ? `[${code}] ${message}` : message,
    attributes: {
      [LF.observationLevel]: "ERROR",
      [LF.observationType]: "span",
      [LF.sessionId]: args.sessionId,
      [LF.environment]: langfuseEnvironment(env),
      // A failure observation with no input/output tells a reader nothing
      // about WHO it happened to or WHAT to do — so it carries the question
      // that failed, and the diagnosis as its output.
      [LF.observationInput]: recordContent
        ? (args.question ?? "(question not captured for this turn)")
        : REDACTED,
      [LF.observationOutput]: JSON.stringify(
        {
          failed_at: KIND_LABEL[args.kind],
          error_type: known?.error_type ?? "unexpected",
          cause: known?.cause ?? "Not a recognised failure pattern — read the raw message.",
          user_impact: impact,
          recommended_action:
            known?.recommended_action ??
            "Inspect the raw error and the surrounding trace, then retry or escalate.",
          raw_error: code ? `[${code}] ${message}` : message,
        },
        null,
        2,
      ),
      ...appMetadata(env),
      "app.agent": args.agentName,
      "app.agent.label": KB_AGENT_LABEL,
      "app.failure.kind": args.kind,
      "app.failure.subject": args.subject,
      "app.failure.stage": args.kind === "tool" ? `calling ${args.subject}` : KIND_LABEL[args.kind],
      "app.error_type": known?.error_type ?? "unexpected",
      "app.error_cause": known?.cause ?? "Not a recognised failure pattern — read the raw message.",
      "app.raw_error": code ? `[${code}] ${message}` : message,
      "app.user_impact": impact,
      "app.recommended_action":
        known?.recommended_action ??
        "Inspect the raw error and the surrounding trace, then retry or escalate.",
      "app.channel.kind": args.channelKind ?? "unknown",
      "eve.session.id": args.sessionId,
    },
  };
}

// ---------------------------------------------------------------------------
// Turn journal — the trace-level story of one turn.
//
// The OTLP trace root is a workflow-infrastructure span: it carries no inputs,
// outputs or business context, so without this the Langfuse trace list would
// show an unreadable row per request. The hook listens to the stream events
// and, at turn end, emits ONE summary span carrying the trace-level fields
// Langfuse reads (`langfuse.trace.*`).
// ---------------------------------------------------------------------------

interface TurnState {
  userMessage?: string;
  reply?: string;
  startedAt?: number;
  firstTokenAt?: number;
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

/** eve's usage field names are not pinned by the docs; accept the common AI SDK
 *  spellings defensively. A wrong guess costs nothing (0 tokens). */
function usageTokens(usage: unknown): { input: number; output: number; cached: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
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

/** USD per 1M tokens, keyed by a substring of the model / Azure deployment
 *  name. A client-side ESTIMATE only — Langfuse's own pricing on the generation
 *  observation remains authoritative. */
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

/** Rough USD estimate. Returns 0 for an unknown model — we never invent a price. */
export function estimateCostUsd(model: string, input: number, output: number, cached = 0): number {
  const p = MODEL_PRICES.find((e) => e.match.test(model));
  if (!p) return 0;
  const uncachedInput = Math.max(0, input - cached);
  return (uncachedInput * p.inPer1M + cached * p.cachedInPer1M + output * p.outPer1M) / 1_000_000;
}

const REDACTED = "[content capture off — set LANGFUSE_RECORD_IO=true]";

/** The TRACE title, which is the first and often only thing a reviewer reads.
 *  It names the agent AND quotes the visitor's question, because "which agent,
 *  asked what" is the question a trace list has to answer at a glance.
 *  With content capture off it degrades to a shape-only description rather
 *  than leaking text into a field that is displayed everywhere. */
export function traceTitle(
  question: string | undefined,
  recordContent: boolean,
  steps: number,
): string {
  if (!recordContent || !question || question.trim() === "") {
    return `${KB_AGENT_LABEL} · Frage beantwortet (${steps} ${steps === 1 ? "Schritt" : "Schritte"})`;
  }
  const q = question.replace(/\s+/g, " ").trim();
  return `${KB_AGENT_LABEL} · "${q.length > 80 ? `${q.slice(0, 80)}…` : q}"`;
}

export interface TurnSummarySpan {
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | string[]>;
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
      case "message.appended": {
        // First streamed content — gives time-to-first-token, the number that
        // decides whether the widget felt responsive.
        if (t.firstTokenAt === undefined) t.firstTokenAt = now;
        break;
      }
      case "message.completed": {
        const text = (data?.text ?? data?.message ?? data?.content) as unknown;
        if (typeof text === "string" && text.trim() !== "") t.reply = text;
        break;
      }
    }
  }

  /** Build the summary span for a finished turn and clear its state. Returns
   *  undefined when nothing was journaled — better no span than a misleading
   *  empty one. */
  finalize(args: {
    sessionId: string;
    outcome: "answered" | "failed";
    agentName: string;
    channelKind?: string;
    recordContent: boolean;
    now: number;
    systemPrompt?: string;
    env?: NodeJS.ProcessEnv;
  }): TurnSummarySpan | undefined {
    const env = args.env ?? process.env;
    const t = this.turns.get(args.sessionId);
    this.turns.delete(args.sessionId);
    if (!t || (t.userMessage === undefined && t.steps === 0)) return undefined;

    const userMessage = args.recordContent ? (t.userMessage ?? "") : REDACTED;
    const reply = args.recordContent ? (t.reply ?? "") : REDACTED;
    const start = t.startedAt ?? args.now;
    const model = appMetadata(env)["app.model"] ?? "unknown";
    const kb = knowledgeSource(args.systemPrompt);
    const durationMs = args.now - start;
    const costUsd = estimateCostUsd(model, t.inputTokens, t.outputTokens, t.cachedTokens);

    /** What a reviewer needs on the TRACE row, in plain language. */
    const facts: Record<string, string> = {
      agent: KB_AGENT_LABEL,
      "agent.id": args.agentName,
      "agent.role": KB_AGENT_ROLE,
      outcome: args.outcome,
      model,
      channel: args.channelKind ?? "unknown",
      "knowledge.mode": kb?.mode ?? KB_KNOWLEDGE_MODE,
      "knowledge.source": kb?.source ?? KB_KNOWLEDGE_SOURCE,
      "knowledge.version_digest": kb?.digest ?? "unknown",
      "knowledge.size_chars": kb?.chars ?? "unknown",
      "knowledge.approx_tokens": kb?.approxTokens ?? "unknown",
      "knowledge.sections": kb?.sections ?? "unknown",
      "knowledge.retrieved": "nothing — the KB is already in the prompt, no lookup happens",
      "tools.available": KB_TOOLS_AVAILABLE,
      "tools.called": t.toolsUsed.join(", ") || "none",
      "tools.errors": String(t.toolErrors),
      "steps.model_calls": String(t.steps),
      "timing.duration_ms": String(durationMs),
      "timing.first_token_ms":
        t.firstTokenAt !== undefined ? String(t.firstTokenAt - start) : "not observed",
      "tokens.input": String(t.inputTokens),
      "tokens.output": String(t.outputTokens),
      "tokens.cached_input": String(t.cachedTokens),
      "tokens.total": String(t.inputTokens + t.outputTokens),
      "cost.estimate_usd": costUsd.toFixed(6),
    };

    return {
      name: SPAN.summary,
      startMs: start,
      endMs: args.now,
      attributes: {
        [LF.observationType]: "span",
        [LF.sessionId]: args.sessionId,
        [LF.environment]: langfuseEnvironment(env),

        // --- Trace level: what the trace list and trace header show ---------
        [LF.traceName]: traceTitle(t.userMessage, args.recordContent, t.steps),
        [LF.traceInput]: userMessage,
        [LF.traceOutput]: reply,
        [LF.traceTags]: [
          "navio",
          "kb-agent",
          "prompt-embedded-kb",
          "no-tools",
          `channel:${args.channelKind ?? "unknown"}`,
          `outcome:${args.outcome}`,
        ],
        ...traceMetadata(facts),

        // --- Observation level: the summary readable on its own -------------
        // The facts above are NOT repeated here as `app.*`. Langfuse surfaces
        // `langfuse.trace.metadata.*` on the observation too, so duplicating
        // them only doubles the metadata pane. Only identifiers that are not
        // already trace metadata are added.
        [LF.observationInput]: userMessage,
        [LF.observationOutput]: reply,
        ...(langfuseRecordSystemPrompt(env) && args.systemPrompt
          ? { "app.system_prompt": args.systemPrompt }
          : {}),
        "app.version": appMetadata(env)["app.version"] ?? "dev",
        "eve.session.id": args.sessionId,
      },
    };
  }
}
