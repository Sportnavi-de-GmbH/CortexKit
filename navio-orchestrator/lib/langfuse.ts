// The central Langfuse module for the NAVIO ORCHESTRATOR (service 3) —
// every Langfuse decision lives here; agent/instrumentation.ts and
// agent/hooks/langfuse.ts are thin consumers.
//
// Third in the family, after kb-agent-langsmith-starter/lib/langfuse.ts (FAQ)
// and SportnaviPartnerRecomandationBot/.../lib/langfuse.ts (Partner). Same
// transport contract and the same invariants; what differs is WHAT A TRACE HAS
// TO SAY, because this service is a router, not an answerer.
//
// ── WHICH PROJECT, AND WHY THAT IS THE ONLY HONEST ANSWER ───────────────────
// A Langfuse project is selected by the key pair in the environment, and ONE
// process exports to ONE project. This service's env carries the
// "Navio — Multi-Agent" keys, so the orchestration trace lands there.
//
// That is deliberate, not a compromise, because the alternative is worse:
//   * The FAQ specialist here is a LOCAL SUBAGENT running IN THIS PROCESS —
//     it is not service 1. Sending its spans to the FAQ project would tear one
//     request's trace in half, and a trace cannot span two projects: you would
//     get two orphaned fragments instead of one story.
//   * The partner specialist IS a separate service (service 2) reached over
//     HTTP. It already traces itself, in full, into "Navio — Partner". So
//     partner execution genuinely lands in the Partner project — we record the
//     partner-side session id on our tool span so the two can be joined.
//
// Net effect: one connected orchestration trace here, plus a real partner trace
// there, with an explicit link between them. See PARTNER_LINK below.
//
// INVARIANTS (identical to the sibling services)
//   * missing credentials => complete no-op (a fresh clone runs credential-free)
//   * observability never throws and never blocks a turn
//   * content capture is off unless LANGFUSE_RECORD_IO=true
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Shown instead of real text when content capture is off. */
const REDACTED = "[content capture off — set LANGFUSE_RECORD_IO=true]";

// ---------------------------------------------------------------------------
// Endpoint, auth, enablement
// ---------------------------------------------------------------------------

export const LANGFUSE_OTEL_TRACES_PATH = "/api/public/otel/v1/traces";
export const LANGFUSE_PUBLIC_API_PATH = "/api/public";

export function langfuseBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST ?? "";
  return raw.trim().replace(/\/+$/, "");
}

/** Enabled only when host + BOTH keys are present. Anything less counts as
 *  "not configured", so every Langfuse surface stays a silent no-op — and the
 *  pre-existing LangSmith pipe keeps working untouched. */
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

export function langfuseAuthHeader(env: NodeJS.ProcessEnv = process.env): string {
  const pk = (env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const sk = (env.LANGFUSE_SECRET_KEY ?? "").trim();
  return `Basic ${Buffer.from(`${pk}:${sk}`, "utf8").toString("base64")}`;
}

/** The `x-langfuse-ingestion-version: 4` header is LOAD-BEARING — without it
 *  traces can lag ~10 minutes and you will think the integration is broken. */
export function langfuseHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    Authorization: langfuseAuthHeader(env),
    "x-langfuse-ingestion-version": "4",
  };
}

/** Documented constraint: `^(?!langfuse)[a-z0-9-_]+$`, max 40 chars — an
 *  invalid value makes Langfuse REJECT the span, so normalize, never pass
 *  through. */
export function langfuseEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LANGFUSE_TRACING_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? "development";
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 40);
  if (cleaned === "" || cleaned.startsWith("langfuse")) return "development";
  return cleaned;
}

export function langfuseRecordIo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_RECORD_IO === "true";
}

export function langfuseRecordSystemPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_RECORD_SYSTEM_PROMPT === "true" && langfuseRecordIo(env);
}

/** Whether to export eve's structural graph spans (workflow nodes, durable
 *  steps, transport fetches).
 *
 *  DEFAULT OFF — and note this is the OPPOSITE of the LangSmith pipe in this
 *  same project, which defaults to complete. Measured on the FAQ agent: one
 *  turn went from 9 to 112 observations, 89 of them transport chatter. An
 *  orchestrator turn is larger still (router + subagent + tool), so leaving it
 *  on would be the single most expensive mistake in this file. */
export function traceCompleteness(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LANGFUSE_TRACE_COMPLETENESS?.trim().toLowerCase();
  return v === "complete" || v === "full" || v === "true";
}

/** eve's AI SDK emits usage on BOTH the `invoke_agent` aggregator and its inner
 *  `chat` spans; Langfuse prices every observation carrying usage. */
export function dedupeUsage(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_DEDUPE_USAGE !== "false";
}

export function isUsageAggregatorSpan(name: string): boolean {
  return name.startsWith("invoke_agent");
}

export function isUsageAttribute(key: string): boolean {
  return /usage|token/i.test(key);
}

// ---------------------------------------------------------------------------
// Who this service is
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_LABEL = "Navio-Orchestrator";

export const ORCHESTRATOR_ROLE =
  "Navio master router — the only agent the visitor talks to. Detects intent and delegates to a specialist (FAQ subagent, partner search, or human hand-off); it answers almost nothing itself.";

/** The router's own knowledge is deliberately tiny — the 16.7k-token knowledge
 *  base belongs to the FAQ subagent and must never leak up here. Stating it
 *  stops a reviewer hunting for a knowledge base on the router's spans. */
export const ORCHESTRATOR_KNOWLEDGE_MODE =
  "routing prompt only (~2k tokens) — the orchestrator holds no product knowledge; the FAQ subagent owns the knowledge base and the partner service owns the directory";
export const ORCHESTRATOR_KNOWLEDGE_SOURCE = "agent/instructions.md (routing rules)";

/** Where a delegated specialist's own detail lives. Recorded on the trace so a
 *  reviewer knows which OTHER Langfuse project to open, and with which id. */
export const PARTNER_LINK = {
  project: "Navio — Partner",
  note: "The partner service (service 2) traces its own search in full, in its own Langfuse project. Look up partner.session_id there for the retrieval detail.",
} as const;

export function appMetadata(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "app.model": env.AZURE_ROUTER_DEPLOYMENT_NAME ?? env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "unknown",
    "app.version": env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev",
    "app.environment": langfuseEnvironment(env),
  };
}

// ---------------------------------------------------------------------------
// Langfuse attribute names
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

export function traceMetadata(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [`${LF.traceMetadataPrefix}${k}`, v]),
  );
}

// ---------------------------------------------------------------------------
// The capabilities the router chooses between.
//
// This table IS the routing contract, in the same order the model sees it.
// Keeping it here (rather than inline) means the trace, the tests and the
// verifier all agree on what a "route" is.
// ---------------------------------------------------------------------------

export type Route =
  | "faq"
  | "find_partners"
  | "request_human_contact"
  | "provide_booking_link"
  | "ask_question"
  | "direct_reply";

export interface RouteInfo {
  /** How it reads in a trace. */
  label: string;
  /** Which agent/service actually does the work. */
  handler: string;
  /** Where that work is traced, if not here. */
  tracedIn: string;
}

export const ROUTES: Record<Route, RouteInfo> = {
  faq: {
    label: "FAQ specialist",
    handler: "FAQ subagent (local, in this process, own child session)",
    tracedIn: "this trace",
  },
  find_partners: {
    label: "partner search",
    handler: "Partner agent (service 2, separate deployment, over HTTP)",
    tracedIn: `${PARTNER_LINK.project} (look up partner.session_id)`,
  },
  request_human_contact: {
    label: "human hand-off",
    handler: "approval gate → Kontaktformular → Salesforce",
    tracedIn: "this trace",
  },
  provide_booking_link: {
    label: "booking link",
    handler: "the orchestrator itself (static config, no delegation)",
    tracedIn: "this trace",
  },
  ask_question: {
    label: "clarifying question",
    handler: "the orchestrator itself (eve ask_question — parks the turn)",
    tracedIn: "this trace",
  },
  direct_reply: {
    label: "answered directly",
    handler: "the orchestrator itself, with no delegation",
    tracedIn: "this trace",
  },
};

/** Map a tool/subagent name from an eve event onto a route. Unknown names are
 *  NOT forced into a bucket — an unrecognised capability should show up as
 *  itself, not be silently mislabelled as a direct reply. */
export function routeForTool(toolName: string): Route | undefined {
  if (toolName === "faq") return "faq";
  if (toolName === "find_partners") return "find_partners";
  if (toolName === "request_human_contact") return "request_human_contact";
  if (toolName === "provide_booking_link") return "provide_booking_link";
  if (toolName === "ask_question") return "ask_question";
  return undefined;
}

// ---------------------------------------------------------------------------
// Span naming — the trace has to read like the orchestration it performed
// ---------------------------------------------------------------------------

export const SPAN = {
  /** eve `workflow.route.flow` — the whole visitor request. Trace root. */
  request: "visitor-request",
  /** eve `ai.eve.turn` — one message -> answer cycle. */
  turn: "navio-turn",
  /** AI SDK `invoke_agent` — one pass of the router's model/tool loop. */
  orchestrate: "orchestrate-request",
  /** AI SDK `step N`. */
  step: "agent-step",
  /** AI SDK `chat` — a billed call. GENERATION. */
  generate: "model-call",
  /** The `faq` subagent tool. */
  delegateFaq: "delegate-to-faq-specialist",
  /** The `find_partners` tool → service 2. */
  findPartners: "delegate-to-partner-service",
  /** The `request_human_contact` tool. */
  humanContact: "hand-off-to-human",
  /** The `provide_booking_link` tool. */
  provideBookingLink: "hand-off-booking-link",
  /** eve's built-in clarification tool (ENABLED on this agent, unlike the others). */
  askQuestion: "ask-visitor-to-clarify",
  /** The hook's readable per-turn summary. */
  summary: "request-completed",
} as const;

/** eve names authored tool spans with the BARE tool name as well as the
 *  `execute_tool <name>` spelling — both are mapped. (Langfuse then overrides a
 *  TOOL observation's name from `gen_ai.tool.name`, which is correct and
 *  expected: for a tool the real name is the readable name.) */
export const TOOL_SPANS: Record<string, string> = {
  faq: SPAN.delegateFaq,
  find_partners: SPAN.findPartners,
  request_human_contact: SPAN.humanContact,
  provide_booking_link: SPAN.provideBookingLink,
  ask_question: SPAN.askQuestion,
};

export function humanSpanName(name: string): string {
  if (name === "workflow.route.flow") return SPAN.request;
  if (name === "ai.eve.turn") return SPAN.turn;
  if (name.startsWith("invoke_agent")) return SPAN.orchestrate;
  if (name.startsWith("chat")) return SPAN.generate;
  // ONE name for every step: the AI SDK restarts step numbering inside each
  // `invoke_agent`, so ordinal-based names ("decide" / "write") are wrong —
  // measured on the partner agent, where a two-pass turn emitted "step 1" twice
  // and "step 2" never.
  if (/^step \d+$/.test(name)) return SPAN.step;
  const explicit = name.match(/^execute_tool\s+(.+)$/);
  const toolName = explicit ? explicit[1] : name;
  const mapped = TOOL_SPANS[toolName];
  if (mapped) return mapped;
  if (explicit) return `tool:${explicit[1]}`;
  return name;
}

export const STEP_PURPOSE: Record<string, string> = {
  [SPAN.request]:
    "The complete visitor request, from the widget's HTTP call to the delivered answer.",
  [SPAN.turn]:
    "One message -> answer cycle. Everything Navio did in response to this single message, including anything it delegated.",
  [SPAN.orchestrate]:
    "One pass of the router's model/tool loop. A delegated turn shows TWO: the pass that picks a specialist and calls it, then the pass that relays the specialist's answer.",
  [SPAN.step]:
    "One step inside a pass: assemble the routing prompt + history, call the model, collect either its tool calls or its reply.",
  [SPAN.generate]:
    "A billed Azure call. On the router this is the ROUTING DECISION (and later the relay); inside the FAQ subagent it is the answer itself. Carries model, tokens and cost.",
  [SPAN.delegateFaq]:
    "Delegation to the FAQ specialist — a local subagent with its own child session and the 16.7k-token knowledge base. Its answer returns as this tool's result and the router relays it verbatim.",
  [SPAN.findPartners]:
    `Delegation to the partner service (service 2) over HTTP. Its own search — city resolution, gap-fill, ranking — is traced in ${PARTNER_LINK.project}; match on partner.session_id.`,
  [SPAN.humanContact]:
    "Escalation to a human: opens the approval gate and the Kontaktformular.",
  [SPAN.provideBookingLink]:
    "Static config lookup — returns the pre-configured scheduling URL for the " +
    "router to relay verbatim. No delegation, no external call, no approval gate.",
  [SPAN.askQuestion]:
    "Navio asked the visitor a clarifying question and parked the turn. Enabled on the orchestrator by design — it is the ambiguity mechanism.",
  [SPAN.summary]:
    "The outcome of the request: what was asked, which specialist was chosen, what came back, and what it cost.",
};

export function langfuseObservationType(spanName: string): string | undefined {
  if (spanName === "ai.eve.turn") return "agent";
  if (spanName.startsWith("execute_tool") || spanName.startsWith("ai.toolCall")) return "tool";
  if (spanName in TOOL_SPANS) return "tool";
  return undefined;
}

/** Spans that carry MEANING for a reader, decided from the NAME alone —
 *  because the decision has to be answerable for a span's ANCESTORS while they
 *  are still open (see instrumentation's re-parenting), and a name is fixed at
 *  creation while attributes are not. */
export function isMeaningfulSpanName(name: string): boolean {
  if (name === "workflow.route.flow") return true; // the trace root
  if (name.startsWith("ai.")) return true;
  if (name.startsWith("invoke_agent") || name.startsWith("chat")) return true;
  if (/^step \d+$/.test(name)) return true;
  if (name.startsWith("execute_tool")) return true;
  if (name in TOOL_SPANS) return true;
  if (name === SPAN.summary || name.startsWith("failure:")) return true;
  return false;
}

export function shouldExportSpan(
  name: string,
  attributeKeys: readonly string[],
  complete = false,
): boolean {
  if (complete) return true;
  if (isMeaningfulSpanName(name)) return true;
  return attributeKeys.some((k) => k.startsWith("app.") || k.startsWith("langfuse."));
}

/** eve emits `workflow.route.flow` for EVERY request its runtime handles,
 *  including dev-console polling that never starts a turn. Those arrive with no
 *  session and no children and become single-observation junk traces —
 *  measured on the partner agent: 78 orphans against 2 real traces. */
export function isTurnScopedSpanName(name: string): boolean {
  return name === "workflow.route.flow";
}

// ---------------------------------------------------------------------------
// Prompt provenance
// ---------------------------------------------------------------------------

export interface KnowledgeSource {
  mode: string;
  source: string;
  digest: string;
  chars: string;
  approxTokens: string;
  sections: string;
}

export function knowledgeSource(systemPrompt: string | undefined): KnowledgeSource | undefined {
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return undefined;
  const sections = [...systemPrompt.matchAll(/^===\s*(.+?)\s*===$/gm)].map((m) => m[1]);
  return {
    mode: ORCHESTRATOR_KNOWLEDGE_MODE,
    source: ORCHESTRATOR_KNOWLEDGE_SOURCE,
    digest: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12),
    chars: String(systemPrompt.length),
    approxTokens: String(Math.round(systemPrompt.length / 4)),
    sections: sections.join(" · ") || "(no === SECTION === headers found)",
  };
}

// ---------------------------------------------------------------------------
// Cross-bundle stores. eve bundles instrumentation and hooks SEPARATELY, so
// module memory is not shared; the bridge is the filesystem. Directories are
// `.data/langfuse-*`, distinct from the LangSmith pipe's own stores.
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

export interface TraceRef {
  traceId: string;
  rootSpanId: string;
}

export const traceRefs = fileStore<TraceRef>(".data/langfuse-traces");
export const systemPromptStore = fileStore<string>(".data/langfuse-prompts");

/**
 * Maps a SUBAGENT'S CHILD SESSION back to the parent request's trace.
 *
 * THE multi-agent problem. eve gives a delegated subagent its own child session
 * and its own stream, so the FAQ specialist's spans arrive tagged with a
 * DIFFERENT `eve.session.id` than the request that caused them. Left alone they
 * form a second, parentless trace — the delegation and the work it produced end
 * up as two unrelated rows, which is exactly the "orphaned trace" outcome this
 * integration exists to prevent.
 *
 * `subagent.called` carries `childSessionId` on the PARENT stream, so the hook
 * records child → parent here and instrumentation stamps the child's spans with
 * the parent's session id.
 */
export const childSessions = fileStore<{ parentSessionId: string; tool: string }>(
  ".data/langfuse-subagents",
);

/** Child session ids belonging to one request, keyed by the PARENT session.
 *
 *  Written by INSTRUMENTATION, not by the hook: `subagent.called` — the only
 *  event carrying `childSessionId` — never reaches the hook layer (measured
 *  2026-08-18 with a wildcard hook; hooks get `subagent.completed`, which does
 *  not carry it). The child's session id IS visible on its own turn span, so
 *  the span processor is the only place that can record it. */
export const delegatedChildren = fileStore<string[]>(".data/langfuse-children");

/** Record a child session against its parent request, idempotently. */
export function rememberDelegation(parentSessionId: string, childSessionId: string): void {
  const existing = delegatedChildren.get(parentSessionId) ?? [];
  if (existing.includes(childSessionId)) return;
  delegatedChildren.set(parentSessionId, [...existing, childSessionId]);
}

export interface TurnIo {
  question?: string;
  reply?: string;
  route?: Route;
  routeTool?: string;
  /** Service 2's own session id, so its trace can be found in its project. */
  partnerSessionId?: string;
}

export const turnIoStore = fileStore<TurnIo>(".data/langfuse-turn-io");

/**
 * (session, turn) → the trace that answered it, plus enough orchestration
 * context to make a review useful without re-opening the code. THE bridge for
 * user feedback: the browser knows `sessionId` + `message.metadata.turnId` but
 * never sees a Langfuse trace id, and must not — trace ids are only meaningful
 * together with server-only project credentials.
 *
 * `route` and `partnerSessionId` are captured here, not re-derived at feedback
 * time, because by the time a visitor clicks 👍/👎 the turn's own journal state
 * is long gone (`TurnJournal.finalize` clears it). This is the ONE place that
 * still knows "which specialist actually answered" when the vote arrives.
 *
 * ⚠ SCOPE: process-local (memory + `.data/`) — exactly right in dev and on a
 * warm instance, not sufficient across a serverless cold start. Feedback then
 * degrades to a SESSION-level score rather than being dropped; see
 * lib/feedback.ts's FeedbackTarget.
 */
export interface FeedbackRef {
  traceId: string;
  /** Which capability actually answered — faq | find_partners | … See §16.3b:
   *  a router turn's own trace can come from ANY route, unlike the two
   *  single-purpose services, so this is what lets "which route gets the most
   *  negative feedback" be answered without re-deriving it from raw spans. */
  route?: Route;
  /** Set only when route === "find_partners". The visitor's answer came from
   *  service 2, which traces its OWN search in ITS OWN Langfuse project
   *  ("Navio — Partner") — this is what lets a reviewer jump from this
   *  feedback to that trace instead of the orchestrator's relay of it. */
  partnerSessionId?: string;
}

const feedbackRefStore = fileStore<FeedbackRef>(".data/langfuse-feedback-refs");

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
 * a second PENDING item for the same trace/session. No TTL: "already queued"
 * should stay true until a human clears the item in Langfuse.
 */
const queuedMarkerStore = fileStore<{ queuedAt: string }>(
  ".data/langfuse-annotation-queue-markers",
);

export const queuedMarkers = {
  has(key: string): boolean {
    return queuedMarkerStore.get(key) !== undefined;
  },
  set(key: string): void {
    queuedMarkerStore.set(key, { queuedAt: new Date().toISOString() });
  },
};

export const MAX_ATTRIBUTE_CHARS = 4_000;

export function isOversizedAttribute(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length <= MAX_ATTRIBUTE_CHARS) return false;
  if (/response|completion|output/i.test(key)) return false;
  return /prompt|input|messages/i.test(key);
}

/** What the model was given, readable. For the router the interesting part is
 *  the DECISION SURFACE: which capabilities it could pick from. */
export function generationInput(args: {
  systemPrompt?: string;
  question?: string;
  route?: Route;
  recordContent: boolean;
}): string {
  const kb = knowledgeSource(args.systemPrompt);
  return JSON.stringify(
    {
      user_message: args.recordContent ? (args.question ?? "(not captured)") : REDACTED,
      routing: {
        chose: args.route ?? "(not decided yet at this point in the turn)",
        options: Object.entries(ROUTES)
          .filter(([k]) => k !== "direct_reply")
          .map(([k, v]) => `${k} — ${v.label}`),
      },
      instructions: kb
        ? {
            source: kb.source,
            mode: kb.mode,
            version_digest: kb.digest,
            size_chars: Number(kb.chars),
            approx_tokens: Number(kb.approxTokens),
            sections: kb.sections.split(" · "),
          }
        : "(system prompt not captured for this turn)",
      system_prompt: args.recordContent ? (args.systemPrompt ?? "(not captured)") : REDACTED,
    },
    null,
    2,
  );
}

/** The same context minus the full prompt — for wrapper spans. */
export function contextSummary(args: {
  systemPrompt?: string;
  question?: string;
  route?: Route;
  recordContent: boolean;
}): string {
  const kb = knowledgeSource(args.systemPrompt);
  const route = args.route ? ROUTES[args.route] : undefined;
  return JSON.stringify(
    {
      user_message: args.recordContent ? (args.question ?? "(not captured)") : REDACTED,
      instructions: kb
        ? `${kb.source} · ${kb.chars} chars · ~${kb.approxTokens} tokens · digest ${kb.digest}`
        : "(system prompt not captured for this turn)",
      routing: route
        ? `${args.route} — ${route.label}; handled by ${route.handler}; traced in ${route.tracedIn}`
        : "(no delegation on this turn)",
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Session propagation
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

/** Resolve a session id to the REQUEST it belongs to, following one level of
 *  subagent delegation. Everything Langfuse groups by session must go through
 *  here, or the FAQ specialist's work lands in a session of its own. */
export function requestSessionFor(sessionId: string): string {
  const child = childSessions.get(sessionId);
  return child?.parentSessionId ?? sessionId;
}

// ---------------------------------------------------------------------------
// Failure stories
// ---------------------------------------------------------------------------

export type FailureKind = "tool" | "step" | "turn" | "session";

export interface ToolStory {
  human: string;
  user_goal: string;
}

export const TOOL_STORIES: Record<string, ToolStory> = {
  faq: { human: "the FAQ specialist", user_goal: "Understand a Sportnavi rule, price or process" },
  find_partners: {
    human: "the partner search service",
    user_goal: "Find a real place to train",
  },
  request_human_contact: {
    human: "the human hand-off",
    user_goal: "Reach a person at Sportnavi",
  },
  provide_booking_link: {
    human: "the booking link",
    user_goal: "Schedule a meeting with the Sportnavi team",
  },
  ask_question: { human: "a clarifying question", user_goal: "Be understood correctly" },
};

export function toolStory(toolName: string): ToolStory {
  return TOOL_STORIES[toolName] ?? { human: toolName, user_goal: "unknown" };
}

export const FAILURE_PATTERNS: {
  match: RegExp;
  error_type: string;
  cause: string;
  recommended_action: string;
}[] = [
  {
    match: /PARTNER_AGENT_HOST is not configured/i,
    error_type: "misconfigured",
    cause: "PARTNER_AGENT_HOST is unset, so partner search is unavailable in this deployment.",
    recommended_action:
      "Set PARTNER_AGENT_HOST to the partner agent's own host/port (locally e.g. http://127.0.0.1:3005 — NOT the widget's port).",
  },
  {
    match: /Partner service returned HTTP|Partner stream returned HTTP|Partner service unreachable/i,
    error_type: "upstream_unavailable",
    cause: "The partner service (service 2) did not answer.",
    recommended_action:
      "Check the partner agent is running and PARTNER_AGENT_HOST points at IT, not at another Navio service. A wrong port silently reaches the FAQ widget instead.",
  },
  {
    match: /exceeded .*s and was cancelled|timeout|timed out|ETIMEDOUT|aborted/i,
    error_type: "timeout",
    cause: "A delegated call did not return in time (partner search budget is 90s).",
    recommended_action:
      "Check service 2's latency and PARTNER_AGENT_TIMEOUT_MS; a dense city takes 30–60s.",
  },
  {
    match: /empty answer/i,
    error_type: "unexpected",
    cause:
      "A specialist returned a turn with no assistant text — the signature of an ask_question-style park in a service that should not do that.",
    recommended_action:
      "Check that the partner agent still disables ask_question (workspace CLAUDE.md §10.2).",
  },
  {
    match: /invalid subscription key|access denied|401/i,
    error_type: "permission_denied",
    cause: "Azure OpenAI rejected the credentials.",
    recommended_action:
      "Check AZURE_ROUTER_* / AZURE_AI_CHATBOT_* for this environment. If a second dev server is running it may be answering with ITS environment.",
  },
  {
    match: /rate limit|429|too many requests/i,
    error_type: "upstream_unavailable",
    cause:
      "Azure returned 429. One visitor turn here can cost a router call PLUS a 16.7k-token FAQ subagent call.",
    recommended_action:
      "Compare the Azure TPM ceiling against the combined router + subagent cost on this trace.",
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
  tool: "delegation",
  step: "agent-step",
  turn: "agent-turn",
  session: "agent-session",
};

export interface FailureSpan {
  name: string;
  statusMessage: string;
  attributes: Record<string, string>;
}

export function failureSpan(args: {
  kind: FailureKind;
  subject: string;
  data: unknown;
  sessionId: string;
  agentName: string;
  channelKind?: string;
  question?: string;
  route?: Route;
  recordContent?: boolean;
  env?: NodeJS.ProcessEnv;
}): FailureSpan {
  const env = args.env ?? process.env;
  const { message, code } = failureMessage(args.data, `eve ${args.kind} failed`);
  const known = FAILURE_PATTERNS.find((p) => p.match.test(message));
  const recordContent = args.recordContent ?? langfuseRecordIo(env);
  const story = args.kind === "tool" ? toolStory(args.subject) : undefined;
  const impact =
    args.kind === "session"
      ? "The visitor's session ended without an answer."
      : args.kind === "tool"
        ? `Navio could not complete the delegation to ${story?.human ?? args.subject}, so the visitor did not get what they asked for.`
        : "The visitor did not get an answer to this message.";

  return {
    name: `failure:${KIND_LABEL[args.kind]}`,
    statusMessage: code ? `[${code}] ${message}` : message,
    attributes: {
      [LF.observationLevel]: "ERROR",
      [LF.observationType]: "span",
      [LF.sessionId]: args.sessionId,
      [LF.environment]: langfuseEnvironment(env),
      [LF.observationInput]: recordContent
        ? (args.question ?? "(question not captured for this turn)")
        : REDACTED,
      [LF.observationOutput]: JSON.stringify(
        {
          failed_at: KIND_LABEL[args.kind],
          failed_route: args.route ?? args.subject,
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
      "app.agent.label": ORCHESTRATOR_LABEL,
      "app.failure.kind": args.kind,
      "app.failure.subject": args.subject,
      ...(args.route ? { "app.failure.route": args.route } : {}),
      ...(story ? { "app.tool.goal": story.user_goal } : {}),
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
// Turn journal — the trace-level story of one orchestrated request
// ---------------------------------------------------------------------------

interface TurnState {
  userMessage?: string;
  reply?: string;
  startedAt?: number;
  firstTokenAt?: number;
  /** When the model first asked for a capability — the routing latency. */
  routeDecidedAt?: number;
  steps: number;
  route?: Route;
  routeTool?: string;
  delegations: string[];
  partnerSessionId?: string;
  partnerSearchPerformed?: boolean;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** A delegated specialist's usage, reported on the delegation result. Kept
   *  apart from the router's own so neither is double-counted. */
  delegatedInputTokens: number;
  delegatedOutputTokens: number;
  delegatedCachedTokens: number;
  askedForInput: boolean;
}

function freshTurn(): TurnState {
  return {
    steps: 0,
    delegations: [],
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    delegatedInputTokens: 0,
    delegatedOutputTokens: 0,
    delegatedCachedTokens: 0,
    askedForInput: false,
  };
}

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

export function estimateCostUsd(model: string, input: number, output: number, cached = 0): number {
  const p = MODEL_PRICES.find((e) => e.match.test(model));
  if (!p) return 0;
  const uncachedInput = Math.max(0, input - cached);
  return (uncachedInput * p.inPer1M + cached * p.cachedInPer1M + output * p.outPer1M) / 1_000_000;
}

/** The TRACE title — the row a reviewer scans. It names the orchestrator AND
 *  the route it chose, because "what was asked, and who handled it" is the
 *  question a multi-agent trace list has to answer at a glance. */
export function traceTitle(
  question: string | undefined,
  recordContent: boolean,
  route: Route | undefined,
): string {
  const via = route ? ` → ${route}` : "";
  if (!recordContent || !question || question.trim() === "") {
    return `${ORCHESTRATOR_LABEL}${via} · Anfrage bearbeitet`;
  }
  const q = question.replace(/\s+/g, " ").trim();
  return `${ORCHESTRATOR_LABEL}${via} · "${q.length > 70 ? `${q.slice(0, 70)}…` : q}"`;
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
      case "actions.requested": {
        // THE ROUTING DECISION, captured the moment the model makes it and
        // BEFORE the tool runs — which is what makes "where was the routing
        // decision made" answerable, and gives an honest routing latency.
        const names = toolNamesFrom(data);
        for (const name of names) {
          const route = routeForTool(name);
          if (route && t.route === undefined) {
            t.route = route;
            t.routeTool = name;
            t.routeDecidedAt = now;
          }
        }
        break;
      }
      // NOTE: there is deliberately no `subagent.called` case. MEASURED
      // 2026-08-18 with a wildcard hook: the hook layer receives
      // `subagent.completed` but NEVER `subagent.called` — the latter reaches
      // the CLIENT stream only. A handler for it is dead code, and relying on
      // it is what left every delegation field empty on the first live run.
      case "subagent.completed": {
        const name = typeof data?.subagentName === "string" ? data.subagentName : "faq";
        t.delegations.push(name);
        if (t.route === undefined) {
          t.route = routeForTool(name) ?? "faq";
          t.routeTool = name;
          t.routeDecidedAt = now;
        }
        break;
      }
      case "action.result": {
        const result = data?.result as Record<string, unknown> | undefined;
        // A SUBAGENT result is named `subagentName`; a plain tool result is
        // named `toolName`. Reading only `toolName` (the shape every
        // single-agent service uses) silently loses every delegation — measured.
        const name =
          (typeof result?.toolName === "string" && result.toolName) ||
          (typeof result?.subagentName === "string" && result.subagentName) ||
          undefined;
        const output = result?.output as Record<string, unknown> | undefined;
        // `ok: false` counts as a failed delegation even though eve saw a
        // successful tool call — find_partners RETURNS its failures rather than
        // throwing, so `isError` stays false while the partner service is down.
        const isError =
          result?.isError === true || data?.status === "failed" || output?.ok === false;
        if (name && !t.delegations.includes(name)) t.delegations.push(name);
        if (isError) t.toolErrors += 1;

        // THE CHILD'S COST. A delegated subagent runs in its own session, so its
        // `step.completed` events never reach this hook — the parent journal
        // would otherwise report the router's tokens as if they were the whole
        // turn. eve puts the child's usage on the delegation result, which is
        // the only place the parent can see it. Kept SEPARATE from the router's
        // own totals so neither is double-counted.
        const usage = result?.usage;
        if (usage) {
          const { input, output, cached } = usageTokens(usage);
          t.delegatedInputTokens += input;
          t.delegatedOutputTokens += output;
          t.delegatedCachedTokens += cached;
        }

        if (name === "find_partners") {
          const out = output;
          if (out && typeof out === "object") {
            if (typeof out.searchPerformed === "boolean") {
              // Work-actually-performed metric: false means service 2 answered
              // WITHOUT querying its database — the signature of a
              // hallucinating "cost optimization" (workspace CLAUDE.md §10.4).
              t.partnerSearchPerformed = out.searchPerformed;
            }
            if (typeof out.partnerSessionId === "string") {
              t.partnerSessionId = out.partnerSessionId;
            }
          }
        }
        break;
      }
      case "message.appended": {
        if (t.firstTokenAt === undefined) t.firstTokenAt = now;
        break;
      }
      case "message.completed": {
        const text = (data?.text ?? data?.message ?? data?.content) as unknown;
        if (typeof text === "string" && text.trim() !== "") t.reply = text;
        break;
      }
      case "input.requested": {
        t.askedForInput = true;
        if (t.route === undefined) {
          t.route = "ask_question";
          t.routeTool = "ask_question";
          t.routeDecidedAt = now;
        }
        break;
      }
    }
  }

  /** Read the route decided so far, for the span processor. */
  routeOf(sessionId: string): Route | undefined {
    return this.turns.get(sessionId)?.route;
  }

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
    const costUsd = estimateCostUsd(model, t.inputTokens, t.outputTokens, t.cachedTokens);
    // A turn with no delegation is a direct reply — a real, legitimate route,
    // not a missing value.
    const route: Route = t.route ?? "direct_reply";
    const info = ROUTES[route];
    // Written by instrumentation — see delegatedChildren.
    const children = delegatedChildren.get(args.sessionId) ?? [];
    delegatedChildren.delete(args.sessionId);
    const outcome =
      args.outcome === "answered" && t.askedForInput ? "asked-for-clarification" : args.outcome;

    const facts: Record<string, string> = {
      agent: ORCHESTRATOR_LABEL,
      "agent.id": args.agentName,
      "agent.role": ORCHESTRATOR_ROLE,
      outcome,
      model,
      channel: args.channelKind ?? "unknown",
      // --- the orchestration answers ------------------------------------
      "routing.selected": route,
      "routing.selected_label": info.label,
      "routing.handled_by": info.handler,
      "routing.traced_in": info.tracedIn,
      "routing.options": Object.keys(ROUTES).filter((r) => r !== "direct_reply").join(", "),
      "routing.decision_ms":
        t.routeDecidedAt !== undefined ? String(t.routeDecidedAt - start) : "not observed",
      "routing.delegated": t.route ? "yes" : "no",
      "delegation.calls": t.delegations.join(", ") || "none",
      "delegation.child_sessions": children.join(", ") || "none",
      "delegation.errors": String(t.toolErrors),
      "delegation.tokens_input": String(t.delegatedInputTokens),
      "delegation.tokens_output": String(t.delegatedOutputTokens),
      "delegation.tokens_cached": String(t.delegatedCachedTokens),
      ...(t.partnerSessionId
        ? {
            "partner.session_id": t.partnerSessionId,
            "partner.project": PARTNER_LINK.project,
            "partner.note": PARTNER_LINK.note,
          }
        : {}),
      ...(t.partnerSearchPerformed !== undefined
        ? { "partner.search_performed": String(t.partnerSearchPerformed) }
        : {}),
      "knowledge.mode": kb?.mode ?? ORCHESTRATOR_KNOWLEDGE_MODE,
      "knowledge.source": kb?.source ?? ORCHESTRATOR_KNOWLEDGE_SOURCE,
      "knowledge.version_digest": kb?.digest ?? "unknown",
      "knowledge.size_chars": kb?.chars ?? "unknown",
      "knowledge.approx_tokens": kb?.approxTokens ?? "unknown",
      "steps.model_calls": String(t.steps),
      "timing.duration_ms": String(args.now - start),
      "timing.first_token_ms":
        t.firstTokenAt !== undefined ? String(t.firstTokenAt - start) : "not observed",
      "tokens.input": String(t.inputTokens),
      "tokens.output": String(t.outputTokens),
      "tokens.cached_input": String(t.cachedTokens),
      "tokens.total": String(t.inputTokens + t.outputTokens),
      "cost.estimate_usd": costUsd.toFixed(6),
      "cost.note":
        "tokens.* are the ROUTER's own calls. A delegated specialist runs in its own session, so its usage is reported separately as delegation.tokens_* — Langfuse's own per-observation pricing on this trace covers both.",
    };

    return {
      name: SPAN.summary,
      startMs: start,
      endMs: args.now,
      attributes: {
        [LF.observationType]: "span",
        [LF.sessionId]: args.sessionId,
        [LF.environment]: langfuseEnvironment(env),
        [LF.traceName]: traceTitle(t.userMessage, args.recordContent, t.route),
        [LF.traceInput]: userMessage,
        [LF.traceOutput]: reply,
        [LF.traceTags]: [
          "navio",
          "orchestrator",
          "multi-agent",
          `route:${route}`,
          `channel:${args.channelKind ?? "unknown"}`,
          `outcome:${outcome}`,
          ...(children.length > 0 ? ["delegated-to-subagent"] : []),
          ...(t.partnerSessionId ? ["cross-service:partner"] : []),
          ...(t.partnerSearchPerformed === false ? ["partner-answered-without-search"] : []),
        ],
        ...traceMetadata(facts),
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

/** Pull tool names out of an `actions.requested` payload without depending on
 *  its exact shape — eve's docs pin the event, not the field layout, and a
 *  wrong guess must degrade to "no route seen", never throw. */
export function toolNamesFrom(data: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ["toolName", "name", "tool"]) {
      const v = obj[key];
      if (typeof v === "string" && v !== "") names.push(v);
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  visit(data, 0);
  return [...new Set(names)];
}
