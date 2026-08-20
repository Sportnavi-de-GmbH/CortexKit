/**
 * lib/langsmith.ts
 *
 * Central LangSmith module: every region/endpoint/client decision for the
 * LangSmith integration lives here so both runtime entry points
 * (agent/instrumentation.ts and agent/hooks/langsmith.ts) stay thin
 * consumers of it. Adapted from EVE_LANGSMITH_TRACING_GUIDE.md Parts A, B, D
 * for this repo's existing Sentry-based instrumentation (see that file's
 * header comment for why the two coexist on one OTel provider instead of
 * each registering their own).
 *
 * PRIVACY: same rules as lib/observability.ts and lib/sentry-agent.ts — no
 * PII, no partner names/ids, no raw user text unless LANGSMITH_RECORD_IO is
 * explicitly turned on. Every function here is a no-op without an API key.
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { Client } from "langsmith";

import { classify } from "./sentry-agent";

/** The langsmith SDK does not publicly export `CreateRunParams`, so this
 *  extracts its exact shape from `Client.createRun` — keeps our payload
 *  builders precisely typed without duplicating the interface by hand. */
export type LangSmithRunPayload = Parameters<Client["createRun"]>[0];

// The ONE region constant. Every LangSmith URL in the project derives from
// it — this workspace lives in the EU; the US host is every SDK's silent
// default, so nothing may reach it independently.
export const LANGSMITH_EU_API_URL = "https://eu.api.smith.langchain.com";

/** LangSmith's OTLP trace-ingestion endpoint for the EU region. */
export const LANGSMITH_EU_OTEL_TRACES_URL = `${LANGSMITH_EU_API_URL}/otel/v1/traces`;

/** LangSmith is enabled only when an API key is present — a fresh clone or a
 *  CI run with no credentials must stay a silent no-op, never an error. */
export function langsmithEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.LANGSMITH_API_KEY === "string" && env.LANGSMITH_API_KEY.trim() !== "";
}

export function projectName(
  env: NodeJS.ProcessEnv = process.env,
  fallback = "sportnavi-partner-recommendationbot-development",
): string {
  return env.LANGSMITH_PROJECT?.trim() || fallback;
}

/** `true` ships prompts/completions/system-prompt text off-box. Off by
 *  default — same posture as SENTRY_RECORD_IO in lib/sentry-agent.ts. */
export function recordIo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGSMITH_RECORD_IO === "true";
}

/** The one sanctioned way to build a LangSmith SDK client: EU endpoint,
 *  explicit. Returns undefined without a key so callers stay no-op. */
export function createLangsmithClient(env: NodeJS.ProcessEnv = process.env): Client | undefined {
  if (!langsmithEnabled(env)) return undefined;
  return new Client({ apiUrl: LANGSMITH_EU_API_URL, apiKey: env.LANGSMITH_API_KEY });
}

/** Shared metadata block for every run this integration authors — makes
 *  traces filterable by model/version/environment. */
export function appMetadata(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "app.model": env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "unknown",
    "app.version": env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev",
    "app.environment": env.VERCEL_ENV ?? env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
  };
}

// ---------------------------------------------------------------------------
// Step A3 — span filtering. LangSmith drops any span whose parent never
// arrives, and it reconstructs trees from parent links — so filtering must be
// a TREE decision (keep every ancestor of every AI span), never a per-span
// one. See EVE_LANGSMITH_TRACING_GUIDE.md §5 Step A3 for the full rationale.
// ---------------------------------------------------------------------------

/** AI spans carry `ai.`/`gen_ai.` attributes and eve's turn span carries
 *  `eve.`; Workflow-SDK infrastructure spans carry none of those. */
export function shouldExportSpan(name: string, attributeKeys: readonly string[]): boolean {
  if (name.startsWith("ai.")) return true;
  return attributeKeys.some(
    (k) =>
      k.startsWith("ai.") || k.startsWith("gen_ai.") || k.startsWith("eve.") || k.startsWith("app."),
  );
}

/** LangSmith silently DROPS any span whose parent is never ingested — so
 *  when an AI span ends, its whole ancestor chain is marked must-export.
 *  Children always end before their parents, so ancestors see the mark in
 *  time to export themselves when they, in turn, end. */
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
      this.parents.delete(spanId);
      return true;
    }
    const marked = this.mustExport.has(spanId);
    this.mustExport.delete(spanId);
    this.parents.delete(spanId);
    return marked;
  }
}

// ---------------------------------------------------------------------------
// §9.2 — export-time span renaming. Safe: run typing/tokens/tree-stitching
// key off attributes, never names. Only span NAMES are rewritten here —
// attributes always pass through untouched.
// ---------------------------------------------------------------------------

/** A replacement ending in `(` absorbs the rest of the span name as a
 *  parenthesised suffix (`chat gpt-4.1` -> `Generating Response (gpt-4.1)`);
 *  a replacement ending in a space absorbs capture group 1 (`step 1` ->
 *  `Processing Step 1`); anything else is a flat rename. */
const SPAN_NAME_RULES: Array<[RegExp, string]> = [
  [/^invoke_agent /, "Agent Reasoning ("],
  [/^chat /, "Generating Response ("],
  [/^generate_content /, "Generating Content ("],
  // eve 0.25.x emits this span as `eve.turn`, NOT `ai.eve.turn` as the tracing
  // guide's table claims — measured from the KEEP/DROP span log on this agent.
  // Both spellings are matched so an eve upgrade cannot silently un-rename it.
  [/^(ai\.)?eve\.turn$/, "Agent Turn: Understanding & Responding"],
  // AI SDK v7 names each model-call step `step 1`, `step 2`, ... — meaningless
  // in a trace list on its own.
  [/^step (\d+)$/, "Processing Step "],
  [/^workflow\./, "Agent Run (infrastructure)"],
  [/^step\.execute/, "Processing Step (infrastructure)"],
  [/^fetch /, "Agent Run (infrastructure)"],
];

/** Pure mapping table, e.g. `invoke_agent gpt-4.1` -> `Agent Reasoning (gpt-4.1)`. */
export function humanSpanName(name: string): string {
  for (const [pattern, replacement] of SPAN_NAME_RULES) {
    const match = pattern.exec(name);
    if (!match) continue;
    if (replacement.endsWith("(")) {
      const model = name.replace(pattern, "").trim();
      return model ? `${replacement}${model})` : replacement.slice(0, -1).trim();
    }
    if (replacement.endsWith(" ")) {
      const captured = match[1]?.trim();
      return captured ? `${replacement}${captured}` : replacement.trim();
    }
    return replacement;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Cross-bundle file stores. Eve bundles agent/instrumentation.ts and
// agent/hooks/*.ts as SEPARATE module instances, so an in-memory Map shared
// via a lib/ import is invisible across them (verified in the guide) — the
// bridge must be a file, same pattern for both stores below.
// ---------------------------------------------------------------------------

/** Session ids are eve-generated (`wrun_01K...`), but never trust an id
 *  straight into a path — one `/` or `..` would escape the store directory. */
function safeKey(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

function fileStore<T>(dir: string) {
  return {
    dir,
    set(sessionId: string, value: T): void {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/${safeKey(sessionId)}.json`, JSON.stringify(value));
      } catch {
        // Observability must never break the agent.
      }
    },
    get(sessionId: string): T | undefined {
      try {
        return JSON.parse(readFileSync(`${dir}/${safeKey(sessionId)}.json`, "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    delete(sessionId: string): void {
      try {
        unlinkSync(`${dir}/${safeKey(sessionId)}.json`);
      } catch {
        // ok — nothing to clean up
      }
    },
  };
}

/** Part D — the assembled system prompt, written by instrumentation's
 *  `step.started` handler and read by the hook when it builds the root run,
 *  so the prompt lands untruncated (REST runs have no OTel attribute-size
 *  limit) instead of the truncated/absent span-attribute path. */
export const systemPromptStore = fileStore<string>(".data/langsmith-prompts");

// ---------------------------------------------------------------------------
// Part C (EVE_LANGSMITH_TRACING_GUIDE.md §7) — ONE TRACE PER REQUEST.
//
// Without this, each request produces TWO unrelated LangSmith traces:
//   * the hook's REST summary run — user message, reply, system prompt, but
//     `total_cost: null` and `total_tokens: 0`, with no children; and
//   * the OTLP span tree rooted at a workflow-infrastructure span — all the
//     tokens and dollar cost, but `inputs: {}` / `outputs: null` everywhere.
// Neither one alone answers "what did this request do, and what did it cost".
// (Measured on this agent 2026-07-31 before the fix: run
// e406c5f2… held the IO, run 00000000-0000-0000-5aa1-f8b8562d7ee8 held the
// $0.216 — same request, two rows in the trace list.)
//
// The bridge: LangSmith derives an OTLP span's run id DETERMINISTICALLY from
// the span id, so the span filter can compute — inside this process, before
// the spans are ever exported — the exact run id LangSmith will later assign
// to the trace root, and the hook can PRE-CREATE that run as the turn summary.
// The OTLP pipe's own later create of the same id is dropped as a duplicate
// (first writer wins) and its children attach underneath by id.
// ---------------------------------------------------------------------------

export interface TraceAnchor {
  /** The run id LangSmith will derive from the OTLP trace-root span. */
  rootRunId: string;
  /** That root's `dotted_order` segment — required by the API whenever
   *  `trace_id` is set (400 without it). */
  rootDotted: string;
  /** Root span start, in epoch ms, so the summary run spans the whole request. */
  rootStartMs: number;
}

/** LangSmith's OTLP spanId -> runId mapping: a 16-hex span id becomes
 *  `00000000-0000-0000-<first 4>-<last 12>`. Verified against live traces in
 *  this project (span `5aa1f8b8562d7ee8` -> run
 *  `00000000-0000-0000-5aa1-f8b8562d7ee8`). */
export function otelRunId(spanId: string): string {
  return `00000000-0000-0000-${spanId.slice(0, 4)}-${spanId.slice(4)}`;
}

/** `dotted_order` timestamp from an OTel hrTime pair: `YYYYMMDDTHHMMSS<micro6>Z`. */
export function dottedStampFromHr(sec: number, nanos: number): string {
  return dottedStampFromMs(sec * 1000 + Math.floor(nanos / 1e6), Math.floor(nanos / 1000) % 1e6);
}

/** Same stamp from epoch ms (the hook side has no hrTime). */
export function dottedStampFromMs(ms: number, micros?: number): string {
  const d = new Date(ms);
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  const micro = micros ?? (ms % 1000) * 1000;
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1, 2)}${p(d.getUTCDate(), 2)}T` +
    `${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}` +
    `${p(micro, 6)}Z`
  );
}

/** Cross-bundle bridge. eve compiles agent/instrumentation.ts and
 *  agent/hooks/*.ts as SEPARATE module instances, so an in-memory Map shared
 *  through this file is invisible across them — the anchor has to go through
 *  the filesystem, same as systemPromptStore above. */
export const traceAnchors = fileStore<TraceAnchor>(".data/langsmith-anchors");

/** The three fields that graft a REST-created run onto an existing OTLP
 *  trace. Spread onto a payload; empty object = standalone run (degraded but
 *  never broken). */
export interface TraceAttachment {
  id?: string;
  trace_id?: string;
  parent_run_id?: string;
  dotted_order?: string;
}

/** Makes the summary run BE the trace root LangSmith will otherwise create
 *  from the root span. */
export function rootAttachment(anchor: TraceAnchor | undefined): TraceAttachment {
  if (!anchor) return {};
  return { id: anchor.rootRunId, trace_id: anchor.rootRunId, dotted_order: anchor.rootDotted };
}

/** Nests a run (failure records) inside the request's trace as a child of the
 *  root. `runId` must be unique per run. */
export function childAttachment(
  anchor: TraceAnchor | undefined,
  runId: string,
  startMs: number,
): TraceAttachment {
  if (!anchor) return {};
  return {
    id: runId,
    trace_id: anchor.rootRunId,
    parent_run_id: anchor.rootRunId,
    dotted_order: `${anchor.rootDotted}.${dottedStampFromMs(startMs)}${runId}`,
  };
}

/** Optional local span-debug recorder — separates "exporter never saw it"
 *  from "backend hasn't ingested it yet" during troubleshooting. */
export function logSpanDebug(logPath: string, line: string): void {
  try {
    mkdirSync(logPath.includes("/") ? logPath.slice(0, logPath.lastIndexOf("/")) : ".", {
      recursive: true,
    });
    appendFileSync(logPath, `${line}\n`);
  } catch {
    // Diagnostics must never break the agent.
  }
}

// ---------------------------------------------------------------------------
// Part B — failure capture. Eve reports failures as stream events, never
// exceptions (agent/hooks/sentry.ts documents the same fact) — this is the
// only path from an agent failure to a LangSmith run.
// ---------------------------------------------------------------------------

export type FailureKind = "tool" | "step" | "turn" | "session";

export type ErrorType =
  | "invalid_input"
  | "upstream_unavailable"
  | "timeout"
  | "permission_denied"
  | "unexpected";

/** Human display name + business context per tool. Extend as tools are
 *  added. Unlike lib/sentry-agent.ts's regex classifier (built for Sentry
 *  issue grouping), this table exists to make LangSmith failure runs
 *  readable by a non-technical person per §9.3/§9.4 of the tracing guide. */
export const TOOL_META: Record<string, { human: string; userGoal: string }> = {
  extract_city: {
    human: "Intent Extraction Tool",
    userGoal: "Understand which city and activity the user is asking about",
  },
  resolve_partners: {
    human: "Partner Resolution Tool",
    userGoal: "Find enough matching partners in and around the requested city",
  },
  build_recommendations: {
    human: "Recommendation Builder Tool",
    userGoal: "Assemble the final shortlist of partners to recommend",
  },
  get_partner_details: {
    human: "Partner Details Tool",
    userGoal: "Look up full profile details for a specific partner",
  },
  get_partners_by_city: {
    human: "City Partner Lookup Tool",
    userGoal: "List partners already active in the requested city",
  },
  find_nearby_cities: {
    human: "Nearby City Lookup Tool",
    userGoal: "Find neighboring cities to borrow partners from when local coverage is short",
  },
  similarity_search_partners: {
    human: "Similarity Search Tool",
    userGoal: "Find partners similar to the request via vector/embedding search",
  },
  web_search: {
    human: "Web Search Tool",
    userGoal: "Look up current information not present in the partner directory",
  },
  web_fetch: {
    human: "Web Fetch Tool",
    userGoal: "Retrieve the contents of a specific web page",
  },
};

function toolMeta(toolName: string): { human: string; userGoal: string } {
  return TOOL_META[toolName] ?? { human: `${toolName} Tool`, userGoal: "unknown" };
}

/** Maps this project's Sentry failure classes onto LangSmith's controlled
 *  `error_type` vocabulary (dashboards group by it) — reuses classify()
 *  instead of a second bespoke pattern table. */
function errorTypeFor(data: unknown): ErrorType {
  switch (classify(data)) {
    case "integration":
    case "external":
      return "upstream_unavailable";
    default:
      return "unexpected";
  }
}

const RECOMMENDED_ACTION: Record<ErrorType, string> = {
  invalid_input: "Ask the user to rephrase or supply the missing detail, then retry.",
  upstream_unavailable:
    "A dependency (Supabase, the embedding API, or Azure OpenAI) was unreachable — retry shortly; escalate if it persists.",
  timeout: "The call took too long — retry once; escalate if it times out again.",
  permission_denied: "Check credentials/permissions for the dependency and retry.",
  unexpected: "Inspect the raw error and the surrounding trace, then retry or escalate.",
};

/** eve failure payloads are `{ code, message }` (step/turn/session events) or
 *  a raw value (a thrown tool's output). Normalize both. */
export function failureMessage(data: unknown, fallback: string): { message: string; code?: string } {
  if (typeof data === "string" && data.trim() !== "") return { message: data };
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  return {
    message: typeof obj?.message === "string" ? obj.message : fallback,
    code: typeof obj?.code === "string" ? obj.code : undefined,
  };
}

const KIND_LABEL: Record<FailureKind, string> = {
  tool: "Tool Call",
  step: "Agent Step",
  turn: "Agent Turn",
  session: "Agent Session",
};

export function failureRunPayload(args: {
  kind: FailureKind;
  subject: string; // tool name, or error code for step/turn/session
  data: unknown; // the raw event payload — keep it, developers need it
  sessionId: string;
  agentName: string;
  channelKind?: string;
  project: string;
  now: number;
  /** Part C — nests this failure inside the request's trace instead of
   *  stranding it as its own one-run trace. */
  attach?: TraceAttachment;
}): LangSmithRunPayload {
  const { message, code } = failureMessage(args.data, `eve ${args.kind} failed`);
  const meta = args.kind === "tool" ? toolMeta(args.subject) : undefined;
  const humanWho = meta ? meta.human : `${KIND_LABEL[args.kind]} (${args.subject})`;
  const errorType = errorTypeFor(args.data);

  return {
    ...(args.attach ?? {}),
    // Run NAME = the story, readable in the trace list without opening the run.
    name: `${humanWho} Failed: ${message}`.slice(0, 140),
    run_type: "chain",
    inputs: { subject: args.subject },
    // `error` keeps the RAW technical message — developers still need it.
    error: code ? `[${code}] ${message}` : message,
    start_time: args.now,
    end_time: args.now,
    project_name: args.project,
    extra: {
      metadata: {
        ...appMetadata(),
        action: args.kind === "tool" ? args.subject : `${args.kind}_execution`,
        tool: args.kind === "tool" ? args.subject : "none",
        error_type: errorType,
        user_friendly_message: `The agent could not complete this ${KIND_LABEL[args.kind].toLowerCase()}: ${message}`,
        failed_step: args.kind === "tool" ? `Calling ${humanWho}` : KIND_LABEL[args.kind],
        user_goal: meta?.userGoal ?? "unknown",
        recommended_action: RECOMMENDED_ACTION[errorType],
        "app.agent": args.agentName,
        "app.channel.kind": args.channelKind ?? "unknown",
        "eve.session.id": args.sessionId,
        "failure.kind": args.kind,
        "failure.subject": args.subject,
        thread_id: args.sessionId, // LangSmith groups traces into threads by this
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Part B3 — TurnJournal: accumulates one turn's story and, at turn end,
// produces the summary run carrying what the OTLP trace root never can (the
// user message, the agent reply, outcome, duration, token totals, tools
// used). Without it every LangSmith trace-list row reads "No inputs/outputs".
// ---------------------------------------------------------------------------

interface TurnState {
  userMessage?: string;
  /** Last finalized assistant text block (`message.completed`). */
  reply?: string;
  /** Last cumulative streamed text (`message.appended`) — the fallback for
   *  when `message.completed.data.message` arrives `null`, which its own type
   *  declares it may (node_modules/eve/dist/src/protocol/message.d.ts). */
  streamedReply?: string;
  /** A clarifying question the agent asked instead of answering. Such a turn
   *  emits NO assistant text block — the question rides on `input.requested`
   *  (eve's built-in `ask_question` tool). Measured live 2026-07-31: those
   *  turns produced a summary run with no output at all, labelled "answered".
   *  See node_modules/eve/dist/src/runtime/input/types.d.ts. */
  question?: string;
  questionOptions?: string[];
  startedAt?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerCostUsd: number;
  modelSteps: number;
  toolsUsed: string[];
  toolErrors: number;
  finishReason?: string;
}

function emptyTurnState(): TurnState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerCostUsd: 0,
    modelSteps: 0,
    toolsUsed: [],
    toolErrors: 0,
  };
}

export class TurnJournal {
  private readonly sessions = new Map<string, TurnState>();

  private stateFor(sessionId: string): TurnState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = emptyTurnState();
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  record(
    sessionId: string,
    event: string,
    data: Record<string, unknown> | undefined,
    now: number,
  ): void {
    const s = this.stateFor(sessionId);
    if (event === "message.received") {
      // A new user message RESETS this session's state — sessions are
      // multi-turn, and without the reset, tokens/steps/tools accumulate
      // across turns and every later summary is wrong.
      const fresh = emptyTurnState();
      fresh.userMessage = typeof data?.message === "string" ? data.message : undefined;
      fresh.startedAt = now;
      this.sessions.set(sessionId, fresh);
    } else if (event === "step.completed") {
      const d = data as {
        finishReason?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          costUsd?: number;
        };
      };
      s.inputTokens += d?.usage?.inputTokens ?? 0;
      s.outputTokens += d?.usage?.outputTokens ?? 0;
      s.cacheReadTokens += d?.usage?.cacheReadTokens ?? 0;
      s.cacheWriteTokens += d?.usage?.cacheWriteTokens ?? 0;
      s.providerCostUsd += d?.usage?.costUsd ?? 0;
      if (typeof d?.finishReason === "string") s.finishReason = d.finishReason;
      s.modelSteps += 1;
    } else if (event === "message.appended") {
      // `messageSoFar` is the cumulative text of the current block. Kept as a
      // fallback so a null `message.completed.data.message` cannot leave the
      // summary run with no `agent_reply` (observed live on short turns).
      const soFar = (data as { messageSoFar?: unknown })?.messageSoFar;
      if (typeof soFar === "string" && soFar.trim() !== "") s.streamedReply = soFar;
    } else if (event === "message.completed") {
      // eve's field is `message` (typed `string | null`), NOT `text` — the
      // other spellings stay as defensive fallbacks across eve versions. It
      // fires per text block, so the last non-empty one is the reply.
      const text = (data?.message ?? data?.text ?? data?.content) as unknown;
      if (typeof text === "string" && text.trim() !== "") s.reply = text;
    } else if (event === "input.requested") {
      const requests = (data as { requests?: ReadonlyArray<Record<string, unknown>> })?.requests;
      const first = requests?.[0];
      if (typeof first?.prompt === "string" && first.prompt.trim() !== "") {
        s.question = first.prompt;
        const options = first.options;
        s.questionOptions = Array.isArray(options)
          ? options
              .map((o) => (o as { label?: unknown })?.label)
              .filter((l): l is string => typeof l === "string")
          : undefined;
      }
    } else if (event === "action.result") {
      const r = (data as { result?: { toolName?: string; isError?: boolean } })?.result;
      if (r?.toolName) s.toolsUsed.push(r.toolName);
      if (r?.isError) s.toolErrors += 1;
    }
  }

  /** Emit the summary-run payload for a finished turn, then reset the session. */
  finalize(args: {
    sessionId: string;
    outcome: "answered" | "failed";
    agentName: string;
    channelKind?: string;
    project: string;
    recordContent: boolean;
    systemPrompt?: string;
    /** Part C — when present, this run BECOMES the OTLP trace's root, so the
     *  llm/tool children (and their token counts and dollar cost) roll up
     *  into the same trace that carries the conversation IO. */
    anchor?: TraceAnchor;
    now: number;
  }): LangSmithRunPayload | undefined {
    const s = this.sessions.get(args.sessionId);
    if (!s) return undefined;
    this.sessions.delete(args.sessionId);

    const title =
      args.recordContent && s.userMessage
        ? `Customer Request: "${s.userMessage.slice(0, 80)}"`
        : "Customer Request";

    const inputs: Record<string, unknown> = args.recordContent ? { user_message: s.userMessage } : {};
    if (args.recordContent && args.systemPrompt) inputs.system_prompt = args.systemPrompt;

    const reply = s.reply ?? s.streamedReply;
    // A turn that ended by asking the user something did not "answer" — say so
    // rather than filing an answered turn with an empty output.
    const outcome = args.outcome === "answered" && !reply && s.question ? "asked_user" : args.outcome;
    // The root must start no later than the OTLP root span it replaces,
    // otherwise its dotted_order stamp disagrees with its start_time.
    const startTime = args.anchor?.rootStartMs ?? s.startedAt ?? args.now;

    return {
      ...rootAttachment(args.anchor),
      name: title,
      run_type: "chain",
      inputs,
      outputs: args.recordContent
        ? {
            agent_reply: reply ?? s.question,
            ...(s.question ? { agent_question: s.question } : {}),
            ...(s.questionOptions?.length ? { agent_question_options: s.questionOptions } : {}),
            outcome,
          }
        : { outcome },
      start_time: startTime,
      end_time: args.now,
      project_name: args.project,
      extra: {
        metadata: {
          ...appMetadata(),
          "eve.session.id": args.sessionId,
          thread_id: args.sessionId,
          "app.outcome": outcome,
          "app.duration_ms": args.now - (s.startedAt ?? args.now),
          "app.model_steps": s.modelSteps,
          "app.tools_used": s.toolsUsed.join(","),
          "app.tool_errors": s.toolErrors,
          "app.finish_reason": s.finishReason ?? "unknown",
          // Immediate-visibility channel only. Cost/tokens on the run itself
          // are a SERVER-SIDE rollup of the llm children; setting LangSmith's
          // native usage fields here would double count (guide §8.2).
          "app.tokens.input": s.inputTokens,
          "app.tokens.output": s.outputTokens,
          "app.tokens.total": s.inputTokens + s.outputTokens,
          "app.tokens.cache_read": s.cacheReadTokens,
          "app.tokens.cache_write": s.cacheWriteTokens,
          "app.provider_cost_usd": s.providerCostUsd,
          // Proves the trace was grafted; "standalone" means the anchor
          // bridge did not fire and this turn's IO and cost are in separate
          // traces again — the exact regression Part C exists to prevent.
          "app.trace_shape": args.anchor ? "anchored" : "standalone",
        },
      },
    };
  }
}
