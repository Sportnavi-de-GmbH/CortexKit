// The central Langfuse module for the PARTNER AGENT (Navio service 2) —
// every Langfuse decision lives here, and the two runtime entry points
// (agent/instrumentation.ts, agent/hooks/langfuse.ts) are thin consumers.
//
// This is the sibling of kb-agent-langsmith-starter/lib/langfuse.ts, which
// does the same job for the FAQ agent. The two services are SEPARATE
// deployments with SEPARATE `LANGFUSE_*` environments, and that is the whole
// mechanism by which each agent lands in its own Langfuse project:
//
//     service 1 env → project "Navio — FAQ"
//     service 2 env → project "Navio — Partner"     ← this file
//
// Nothing in the code names a project; the key pair decides it. So the FAQ
// agent's configuration cannot be affected by anything here.
//
// ADDITIVE, NOT A REPLACEMENT. Unlike service 1 (where Langfuse replaced
// LangSmith), this agent keeps Sentry and LangSmith exactly as they were —
// see agent/instrumentation.ts for how all three share one OTel provider.
//
// WHY OTLP AND NOT THE LANGFUSE SDK
// Langfuse ingests plain OTLP, and eve's AI SDK v7 telemetry already emits
// gen_ai.* spans, which Langfuse maps natively (model, tokens, cost). So this
// integration points an OTLP exporter at Langfuse and adds `langfuse.*`
// attributes. No Langfuse SDK, no business-logic changes.
//
// Contract, verified against the running instance's OpenAPI spec (v4.6.0)
// and langfuse.com/integrations/native/opentelemetry:
//   POST <host>/api/public/otel/v1/traces
//   Authorization: Basic base64("<public key>:<secret key>")
//   x-langfuse-ingestion-version: 4   ← real-time v4 ingestion. Without it,
//                                       traces can lag up to ~10 minutes.
//
// INVARIANTS
//   * missing credentials => complete no-op (a fresh clone runs credential-free)
//   * observability never throws and never blocks a turn
//   * content capture is off unless LANGFUSE_RECORD_IO=true
//   * partner PII (email/phone) never enters an attribute this module builds
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Shown instead of real text when content capture is off. */
const REDACTED = "[content capture off — set LANGFUSE_RECORD_IO=true]";

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
 *  "not configured", so every Langfuse surface stays a silent no-op — and,
 *  critically, Sentry and LangSmith keep working untouched. */
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
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 40);
  if (cleaned === "" || cleaned.startsWith("langfuse")) return "development";
  return cleaned;
}

/** `true` ships prompts, completions and partner names to Langfuse. Off by
 *  default: this agent serves a public, anonymous widget and visitor text is
 *  personal data. Partner contact details are public directory data, but they
 *  still travel only when content capture is explicitly turned on. */
export function langfuseRecordIo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_RECORD_IO === "true";
}

/** `true` puts the ENTIRE assembled system prompt on the summary observation.
 *  Off by default — it replays on every turn and would dominate trace storage.
 *  The prompt *fingerprint* is always recorded, which is what actually answers
 *  "which instructions produced this answer". */
export function langfuseRecordSystemPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGFUSE_RECORD_SYSTEM_PROMPT === "true" && langfuseRecordIo(env);
}

/** Whether to export eve's structural graph spans (workflow nodes, durable
 *  steps, transport fetches) alongside the AI spans.
 *
 *  DEFAULT: OFF — measured on the FAQ agent, not assumed: with it on, ONE turn
 *  produced 112 observations, 89 of them eve's internal transport chatter.
 *  That is a 14x cost multiplier on a per-observation-priced backend, and it
 *  buries the spans a reader wants. A partner turn is bigger still (two model
 *  steps plus a tool), so the ratio is no better here.
 *
 *  Set LANGFUSE_TRACE_COMPLETENESS=complete when debugging eve itself. */
export function traceCompleteness(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LANGFUSE_TRACE_COMPLETENESS?.trim().toLowerCase();
  return v === "complete" || v === "full" || v === "true";
}

/** COST ACCURACY. eve's AI SDK emits token usage on BOTH the outer
 *  `invoke_agent` aggregator span AND its inner per-call `chat` spans.
 *  Langfuse prices every observation that carries usage, so leaving both in
 *  place double-counts. This matters MORE here than on the FAQ agent: a
 *  partner search makes TWO billed calls, so the aggregator carries the sum of
 *  both and naive export would bill the whole turn a second time. */
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
// without knowing the repo — even though the per-agent project separation
// already makes that unambiguous, a trace should still say so on its own.
// ---------------------------------------------------------------------------

/** Short label used in trace names. */
export const PARTNER_AGENT_LABEL = "Partner-Agent";

/** What this agent is, in one line, for anyone reading a trace cold. */
export const PARTNER_AGENT_ROLE =
  "Navio partner-recommendation agent — finds real Sportnavi studios and courses near a city from the Convex partner directory, and never invents one";

/** The knowledge architecture. The FAQ agent's most surprising property is a
 *  negative (no retrieval); this agent's is the opposite — it DOES retrieve,
 *  and the deterministic pipeline, not the model, does the counting, ranking
 *  and dedupe. Stating it stops anyone reading a ranked list as model output. */
export const PARTNER_KNOWLEDGE_MODE =
  "retrieval — Convex partner directory + embedding similarity (the system prompt holds behaviour rules only, no partner data)";
export const PARTNER_KNOWLEDGE_SOURCE =
  "Convex `partners`/`partnerSearchDocs`/`partnerEmbeddings` tables via lib/partners (resolve city -> gap-fill from nearby cities -> rank -> hydrate profiles)";
export const PARTNER_TOOLS_AVAILABLE =
  "2 (find_partners, get_partner_details); 10 eve built-ins disabled by design";

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
  // eve names authored tool spans with the bare tool name — see AUTHORED_TOOLS.
  if (spanName in AUTHORED_TOOLS) return "tool";
  return undefined;
}

// ---------------------------------------------------------------------------
// Span naming — the trace has to read like a story
//
// Framework names (`workflow.route.flow`, `invoke_agent gpt-4o-mini`,
// `step 1`) describe eve's plumbing, not what happened to the visitor. These
// names describe the WORK, stay stable (so Langfuse can group, filter and
// evaluate by name), and never interpolate the model or the user's text.
//
// The shape differs from the FAQ agent's on purpose, because the WORK differs:
// a partner search is TWO model steps around one deterministic tool call
// (CLAUDE.md §3). The tree makes that visible, which is also the regression
// signal — four steps means the old multi-tool chain came back.
// ---------------------------------------------------------------------------

export const SPAN = {
  /** eve `workflow.route.flow` — the whole visitor request. Trace root. */
  request: "visitor-request",
  /** eve `ai.eve.turn` — one message -> answer cycle. */
  turn: "answer-question",
  /** AI SDK `invoke_agent` — one pass of the model/tool loop. A search turn
   *  produces TWO: the pass that searches, then the pass that writes. */
  recommend: "recommend-partners",
  /** AI SDK `step N` — one step inside a pass. */
  step: "agent-step",
  /** AI SDK `chat` — a billed Azure call. GENERATION. */
  generate: "generate-answer",
  /** The `find_partners` tool span — the deterministic pipeline. TOOL. */
  findPartners: "search-partner-directory",
  /** The `get_partner_details` tool span. TOOL. */
  partnerDetails: "load-partner-details",
  /** The hook's readable per-turn summary. */
  summary: "answer-delivered",
} as const;

/** This agent's authored tools. eve names their spans with the BARE tool name
 *  (verified on a live trace 2026-08-18 — the spans arrived as `find_partners`,
 *  not `execute_tool find_partners`), so both spellings are mapped.
 *
 *  EXPECT THESE NAMES NOT TO WIN, and do not "fix" that. Langfuse's native OTel
 *  mapping names a TOOL observation from its `gen_ai.tool.name` attribute,
 *  which overrides whatever span name we export — verified on the same live
 *  trace, where the observation read `find_partners` while carrying
 *  `gen_ai.tool.name=find_partners` and `gen_ai.operation.name=execute_tool`.
 *  That is the RIGHT outcome: for a tool, the real tool name is the readable
 *  name. This map remains as the fallback for spans that arrive without the
 *  attribute, and so `isMeaningfulSpanName` can recognise a bare tool span. */
export const AUTHORED_TOOLS: Record<string, string> = {
  find_partners: SPAN.findPartners,
  get_partner_details: SPAN.partnerDetails,
};

export function humanSpanName(name: string): string {
  if (name === "workflow.route.flow") return SPAN.request;
  if (name === "ai.eve.turn") return SPAN.turn;
  if (name.startsWith("invoke_agent")) return SPAN.recommend;
  if (name.startsWith("chat")) return SPAN.generate;
  // ONE name for every step. Measured on a live trace: the AI SDK restarts its
  // step numbering inside each `invoke_agent`, so a two-pass search turn emits
  // "step 1" TWICE and "step 2" never — naming them "decide" and "write" by
  // ordinal was simply wrong. The two passes are still legible as the two
  // `recommend-partners` subtrees, in order.
  if (/^step \d+$/.test(name)) return SPAN.step;
  const explicit = name.match(/^execute_tool\s+(.+)$/);
  const toolName = explicit ? explicit[1] : name;
  const mapped = AUTHORED_TOOLS[toolName];
  if (mapped) return mapped;
  if (explicit) return `tool:${explicit[1]}`;
  return name;
}

/** One line per stage explaining what it does and why it exists, stamped onto
 *  the observation so a reader never has to open the source to interpret a
 *  node. Keyed by the RENAMED span name. */
export const STEP_PURPOSE: Record<string, string> = {
  [SPAN.request]:
    "The complete visitor request, from the widget's HTTP call (via the same-origin /api/partner proxy) to the delivered answer.",
  [SPAN.turn]:
    "One message -> answer cycle. Everything the agent did in response to this single message.",
  [SPAN.recommend]:
    "One pass of the model/tool loop over the directory. A search turn shows TWO, in order: the first decides what to search and calls find_partners, the second writes the answer from what came back.",
  [SPAN.step]:
    "One step inside a pass: assemble instructions + history, call the model, collect either its tool calls or its reply. The AI SDK restarts step numbering per pass, so a search turn shows two of these.",
  [SPAN.generate]:
    "A billed Azure OpenAI call. Carries model, token usage and cost. A partner search costs two of these; a greeting or a clarification costs one.",
  [SPAN.findPartners]:
    "The deterministic search pipeline — resolve the city, take the home city whole, gap-fill from nearby cities by embedding similarity, rank, hydrate profiles. The model does no counting, ranking or dedupe here.",
  [SPAN.partnerDetails]: "Loads one partner's full public profile on request.",
  [SPAN.summary]:
    "The outcome of the turn: what the visitor asked, what Navio replied, what was retrieved and what it cost.",
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
  if (name in AUTHORED_TOOLS) return true; // eve names tool spans bare
  // Our own spans.
  if (name === SPAN.summary || name.startsWith("failure:")) return true;
  return false;
}

/** Spans that only make sense as part of an agent turn.
 *
 *  eve emits a `workflow.route.flow` span for EVERY request its runtime
 *  handles — including ones that never start a turn (dev-console polling,
 *  stream reads, health probes). Those arrive with no session, no children and
 *  no content, and each one becomes its own single-observation trace.
 *
 *  MEASURED 2026-08-18 on this project's first live run: 78 such orphan traces
 *  against 2 real ones. They are pure noise on a per-observation-priced
 *  backend and they bury the traces a reviewer wants. */
export function isTurnScopedSpanName(name: string): boolean {
  return name === "workflow.route.flow";
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
// The FAQ agent has no retrieval, so its only provenance question is "which
// VERSION of the prompt". This agent has both:
//
//   1. WHICH INSTRUCTIONS — fingerprinted the same way, because the behaviour
//      rules (honesty invariant, disclosure wording) decide the answer's shape.
//   2. WHAT WAS ACTUALLY RETRIEVED — the real question for a RAG agent, and
//      one the trace can genuinely answer because `find_partners` returns its
//      own accounting (home vs borrowed, which cities, how many shown).
// ---------------------------------------------------------------------------

export interface KnowledgeSource {
  mode: string;
  source: string;
  /** sha256 prefix — changes iff the instruction text changed. */
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
    mode: PARTNER_KNOWLEDGE_MODE,
    source: PARTNER_KNOWLEDGE_SOURCE,
    digest: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12),
    chars: String(systemPrompt.length),
    // ~4 chars/token is the usual English/German approximation. Labelled
    // "approx" so nobody mistakes it for the billed number, which is on the
    // generation observation.
    approxTokens: String(Math.round(systemPrompt.length / 4)),
    sections: sections.join(" · ") || "(no === SECTION === headers found)",
  };
}

/** What one `find_partners` call actually retrieved.
 *
 *  Counts and canonical city names ONLY — the same PII-free contract
 *  lib/observability.ts enforces for the stdout event. Partner names travel
 *  only under LANGFUSE_RECORD_IO, and email/phone never travel at all
 *  (they are not read here, from any field). */
export interface RetrievalFacts {
  /** Canonical resolved city, never the raw user-typed string. */
  requestedCity: string | null;
  homeCount: number;
  filledCount: number;
  /** Canonical names of every city drawn from, home city first. */
  citiesUsed: string[];
  /** How many the visitor actually sees. */
  shown: number;
  minMet: boolean;
  cappedAtMax: boolean;
  citiesExhausted: boolean;
  /** The tool ended by asking the visitor something instead of searching. */
  needsClarification: boolean;
}

/** Read the retrieval accounting out of a `find_partners` result.
 *
 *  eve hands hooks the FULL `execute()` return value, not the trimmed
 *  `toModelOutput` (node_modules/eve/docs/tools/overview.mdx: "Channel event
 *  handlers and hooks still get the full output on `action.result`"), so the
 *  `resolution` block is available without touching the tool.
 *
 *  Structural and defensive rather than typed-imported on purpose: importing
 *  the tool would pull the whole Convex/embedding pipeline into the hook
 *  bundle, and a shape change must degrade to "unknown", never throw. */
export function retrievalFactsFrom(output: unknown): RetrievalFacts | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;

  if (o.needsClarification === true) {
    return {
      requestedCity: null,
      homeCount: 0,
      filledCount: 0,
      citiesUsed: [],
      shown: 0,
      minMet: false,
      cappedAtMax: false,
      citiesExhausted: false,
      needsClarification: true,
    };
  }

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // R13 batched shape: { batch, searches: SearchOutcome[], renderedText }.
  // Resolution accounting lives per-outcome at searches[i].resolution; the
  // canonical city per-outcome at searches[i].built.requestedCity. Facts are
  // aggregated across the executed ("ok") searches of the batch: counts sum,
  // cities union in batch order, minMet only when every executed search met
  // its minimum, the capped/exhausted flags when any did.
  if (Array.isArray(o.searches)) {
    const executed = o.searches.filter((s): s is Record<string, unknown> => {
      if (!s || typeof s !== "object") return false;
      const so = s as Record<string, unknown>;
      return so.status === "ok" && !!so.resolution && typeof so.resolution === "object";
    });
    if (executed.length === 0) return undefined; // nothing searched (all deferred/failed)

    const cities: string[] = [];
    const requestedCities: string[] = [];
    let homeCount = 0;
    let filledCount = 0;
    let shown = 0;
    let minMet = true;
    let cappedAtMax = false;
    let citiesExhausted = false;

    for (const s of executed) {
      const r = s.resolution as Record<string, unknown>;
      const built = s.built as Record<string, unknown> | undefined;
      homeCount += num(r.homeCount);
      filledCount += num(r.filledCount);
      if (Array.isArray(r.citiesUsed)) {
        for (const c of r.citiesUsed) {
          if (typeof c === "string" && !cities.includes(c)) cities.push(c);
        }
      }
      if (built && typeof built === "object") {
        if (Array.isArray(built.recommendations)) shown += built.recommendations.length;
        if (typeof built.requestedCity === "string" && !requestedCities.includes(built.requestedCity)) {
          requestedCities.push(built.requestedCity);
        }
      }
      if (r.minMet !== true) minMet = false;
      if (r.cappedAtMax === true) cappedAtMax = true;
      if (r.citiesExhausted === true) citiesExhausted = true;
    }

    return {
      requestedCity: requestedCities.length > 0 ? requestedCities.join(" + ") : null,
      homeCount,
      filledCount,
      citiesUsed: cities,
      shown,
      minMet,
      cappedAtMax,
      citiesExhausted,
      needsClarification: false,
    };
  }

  // Legacy single-search shape (pre-R13): top-level resolution/recommendations.
  const r = o.resolution as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return undefined;

  return {
    requestedCity: typeof o.requestedCity === "string" ? o.requestedCity : null,
    homeCount: num(r.homeCount),
    filledCount: num(r.filledCount),
    citiesUsed: Array.isArray(r.citiesUsed) ? r.citiesUsed.filter((c) => typeof c === "string") : [],
    shown: Array.isArray(o.recommendations) ? o.recommendations.length : 0,
    minMet: r.minMet === true,
    cappedAtMax: r.cappedAtMax === true,
    citiesExhausted: r.citiesExhausted === true,
    needsClarification: false,
  };
}

/** One sentence answering "what knowledge did this answer come from" — the
 *  §16.3b question a RAG trace must answer without opening the code. */
export function retrievalSummary(facts: RetrievalFacts | undefined): string {
  if (!facts) return "nothing — no directory search ran this turn";
  if (facts.needsClarification) {
    return "nothing — the search stopped to ask the visitor a question (no city, ambiguous city, or timeout)";
  }
  const borrowed =
    facts.filledCount > 0
      ? `${facts.filledCount} borrowed from nearby cities`
      : "none borrowed from nearby cities";
  const cities = facts.citiesUsed.length > 0 ? facts.citiesUsed.join(", ") : "(none)";
  const flags = [
    facts.minMet ? null : "below the gap-fill minimum",
    facts.cappedAtMax ? "capped at maxPartners" : null,
    facts.citiesExhausted ? "nearby cities exhausted" : null,
  ].filter(Boolean);
  return (
    `${facts.requestedCity ?? "(city unresolved)"}: ${facts.homeCount} in the home city + ${borrowed} ` +
    `across [${cities}] -> ${facts.shown} shown to the visitor` +
    (flags.length > 0 ? ` (${flags.join("; ")})` : "")
  );
}

// ---------------------------------------------------------------------------
// Cross-bundle stores
//
// eve bundles agent/instrumentation.ts and agent/hooks/*.ts SEPARATELY, so
// module memory is not shared between them. The bridge is the filesystem.
// All I/O is best-effort: observability never breaks the agent.
//
// Directories are `.data/langfuse-*`, deliberately distinct from LangSmith's
// `.data/langsmith-*`, so the two integrations cannot corrupt each other.
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
 *  instrumentation captures it in events["step.started"]. */
export const systemPromptStore = fileStore<string>(".data/langfuse-prompts");

/** What the visitor asked, what Navio replied, and what was retrieved for the
 *  CURRENT turn.
 *
 *  Written by the hook (the only place that sees `message.received`,
 *  `message.completed` and `action.result`) and read by the span processor,
 *  which otherwise has no idea what the conversation was about. Without this
 *  bridge, eve's own spans export with `input: null, output: null` — measured
 *  on the FAQ agent, three of six observations were completely empty,
 *  including the trace root a reviewer opens first. */
export interface TurnIo {
  question?: string;
  reply?: string;
  retrieval?: RetrievalFacts;
}

export const turnIoStore = fileStore<TurnIo>(".data/langfuse-turn-io");

/**
 * (session, turn) → the trace that answered it. The bridge for user feedback.
 *
 * The widget's Partner screen is rendered by service 1, but the trace was
 * produced HERE — so service 1 forwards the visitor's 👍/👎 to this service,
 * which is the only process that can turn (session, turn) into a trace id.
 *
 * ⚠ Process-local (memory + `.data/`), which is right in dev and on a warm
 * instance and NOT sufficient in production, where a feedback POST can land on
 * a different instance than the one that answered. The route degrades to a
 * SESSION-level score rather than dropping the vote; making it trace-precise in
 * production means moving this one map to a shared KV.
 */
export interface FeedbackRef {
  traceId: string;
}

const feedbackRefStore = fileStore<FeedbackRef>(".data/langfuse-feedback-refs");

export const feedbackRefs = {
  set(sessionId: string, turnId: string, ref: FeedbackRef): void {
    feedbackRefStore.set(`${sessionId}__${turnId}`, ref);
  },
  get(sessionId: string, turnId: string): FeedbackRef | undefined {
    return feedbackRefStore.get(`${sessionId}__${turnId}`);
  },
};

/**
 * Marks a (target kind, object id) as already pushed to the Langfuse
 * Annotation Queue, so a retry or a double-click of the same 👎 never creates
 * a second PENDING item for the same trace/session.
 *
 * No TTL: "already queued" should stay true until a human clears the item in
 * Langfuse, not expire on its own.
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

/** Attribute values big enough to make an observation unreadable. The AI SDK
 *  puts the whole message history on `ai.prompt.messages` as escaped JSON —
 *  and for this agent that history includes every rendered partner profile
 *  from the tool result, which is exactly the payload that made a dense city
 *  blow past the Azure TPM ceiling (CLAUDE.md §10.1). Wherever we supply a
 *  readable input of our own, these are dropped.
 *
 *  Matching on SIZE rather than on key names is deliberate: it keeps working
 *  when the AI SDK renames its attributes. */
export const MAX_ATTRIBUTE_CHARS = 4_000;

/** Only the PROMPT side is dropped. Stripping by size alone also removed the
 *  attributes Langfuse derives an observation's OUTPUT from, which silently
 *  emptied three spans on the FAQ agent (measured 2026-08-13) — the answer
 *  text is worth keeping at any size, the replayed prompt is not. */
export function isOversizedAttribute(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length <= MAX_ATTRIBUTE_CHARS) return false;
  if (/response|completion|output/i.test(key)) return false;
  return /prompt|input|messages/i.test(key);
}

/** What the model was actually given, as something a human can read.
 *
 *  For this agent the interesting half is the RETRIEVAL, not the prompt: the
 *  honesty invariant says every named business must come from a find_partners
 *  result in this conversation, and this is the observation that lets a
 *  reviewer check that claim against the answer. */
export function generationInput(args: {
  systemPrompt?: string;
  question?: string;
  retrieval?: RetrievalFacts;
  recordContent: boolean;
}): string {
  const kb = knowledgeSource(args.systemPrompt);
  return JSON.stringify(
    {
      user_question: args.recordContent ? (args.question ?? "(not captured)") : REDACTED,
      retrieval: {
        summary: retrievalSummary(args.retrieval),
        ...(args.retrieval ?? {}),
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

/** The same context, minus the full prompt text — for the wrapper spans, where
 *  repeating the instructions at every level would bury the trace. */
export function contextSummary(args: {
  systemPrompt?: string;
  question?: string;
  retrieval?: RetrievalFacts;
  recordContent: boolean;
}): string {
  const kb = knowledgeSource(args.systemPrompt);
  return JSON.stringify(
    {
      user_question: args.recordContent ? (args.question ?? "(not captured)") : REDACTED,
      instructions: kb
        ? `${kb.source} · ${kb.chars} chars · ~${kb.approxTokens} tokens · digest ${kb.digest}`
        : "(system prompt not captured for this turn)",
      retrieval: retrievalSummary(args.retrieval),
      tools_available: PARTNER_TOOLS_AVAILABLE,
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

/** Per-tool story table. Unlike the FAQ agent (which ships zero tools and
 *  therefore an empty table), this agent has exactly two, and both have
 *  failure modes that have actually bitten in production. */
export const TOOL_STORIES: Record<string, ToolStory> = {
  find_partners: {
    human: "search the partner directory",
    action: "Resolve the city, gather partners, gap-fill from nearby cities, rank, hydrate.",
    user_goal: "Find real studios or courses they can train at",
    errors: [
      {
        match: /convex|ConvexError|CONVEX_URL|Could not find public function/i,
        headline: "The partner directory was unreachable or refused the query.",
        error_type: "upstream_unavailable",
        user_friendly_message: "Navio could not look up any partners for this request.",
        recommended_action:
          "Check CONVEX_URL / NEXT_PUBLIC_CONVEX_URL points at the seeded deployment (lib/convex.ts reads either). 'Could not find public function' means convex/ was never pushed — run `npx convex dev --once`, then `npm run convex:verify`.",
      },
      {
        match: /embedding/i,
        headline: "The embedding service failed, so nearby-city gap-fill could not run.",
        error_type: "upstream_unavailable",
        user_friendly_message:
          "The visitor may have seen only home-city partners, or fewer than usual.",
        recommended_action: "Check EMBEDDING_API_URL / EMBEDDING_API_KEY and the provider's health.",
      },
      {
        match: /timeout|timed out|ETIMEDOUT|aborted/i,
        headline: "The search pipeline hit its 15s wall-clock deadline.",
        error_type: "timeout",
        user_friendly_message: "The visitor was asked to retry with a narrower request.",
        recommended_action:
          "Check Convex and embedding latency. The deadline bounds the pipeline as a whole; per-stage timeouts are separate.",
      },
    ],
  },
  get_partner_details: {
    human: "load one partner's full profile",
    action: "Fetch a single partner's public directory record.",
    user_goal: "See the details of a partner they were shown",
    errors: [
      {
        match: /convex|ConvexError|not found/i,
        headline: "The partner record could not be loaded.",
        error_type: "upstream_unavailable",
        user_friendly_message: "Navio could not expand on a partner it had already named.",
        recommended_action: "Check the Convex connection and that the partner id still exists.",
      },
    ],
  },
};

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
      "Check AZURE_AI_CHATBOT_API_KEY and AZURE_AI_CHATBOT_OPENAI_ENDPOINT for this environment. If a second dev server is running, it may be answering with ITS environment (CLAUDE.md §16.6.10).",
  },
  {
    match: /rate limit|429|too many requests/i,
    error_type: "upstream_unavailable",
    cause:
      "Azure returned 429. For this agent that is usually SIZE, not frequency: a dense city can render ~100 profiles into one tool result and make the next model call larger than the deployment's whole per-minute allowance (CLAUDE.md §10.1).",
    recommended_action:
      "Compare the Azure TPM ceiling against `maxPartners`/`finalRecommendations` in agent/config/partner-injection.config.ts. Check tokens.input on this trace before assuming a frequency problem.",
  },
  {
    match: /timeout|timed out|ETIMEDOUT|aborted/i,
    error_type: "timeout",
    cause: "A model call or the search pipeline did not return in time.",
    recommended_action:
      "Check Azure health, Convex/embedding latency, and the 15s find_partners deadline.",
  },
  {
    match: /convex|ConvexError|CONVEX_URL|Could not find public function/i,
    error_type: "upstream_unavailable",
    cause:
      "The Convex partner directory refused or failed the query — wrong/unset deployment URL, functions never pushed, or an unseeded deployment.",
    recommended_action:
      "Confirm CONVEX_URL / NEXT_PUBLIC_CONVEX_URL for this environment, then `npx convex dev --once` and `npm run convex:verify` (S1–S6) against it.",
  },
  {
    match: /embedding/i,
    error_type: "upstream_unavailable",
    cause: "The embedding service failed, so nearby-city gap-fill degraded or was skipped.",
    recommended_action: "Check EMBEDDING_API_URL / EMBEDDING_API_KEY and the provider's health.",
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
  // A tool's OWN error table is more specific than the agent-wide one, so it
  // wins when it matches.
  const toolMatch = story?.errors.find((e) => e.match.test(message));
  const known = FAILURE_PATTERNS.find((p) => p.match.test(message));
  const errorType = toolMatch?.error_type ?? known?.error_type ?? "unexpected";
  const cause =
    toolMatch?.headline ??
    known?.cause ??
    "Not a recognised failure pattern — read the raw message.";
  const action =
    toolMatch?.recommended_action ??
    known?.recommended_action ??
    "Inspect the raw error and the surrounding trace, then retry or escalate.";
  const recordContent = args.recordContent ?? langfuseRecordIo(env);
  const impact =
    toolMatch?.user_friendly_message ??
    (args.kind === "session"
      ? "The visitor's session ended without an answer."
      : "The visitor did not get an answer to this message.");

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
          error_type: errorType,
          cause,
          user_impact: impact,
          recommended_action: action,
          raw_error: code ? `[${code}] ${message}` : message,
        },
        null,
        2,
      ),
      ...appMetadata(env),
      "app.agent": args.agentName,
      "app.agent.label": PARTNER_AGENT_LABEL,
      "app.failure.kind": args.kind,
      "app.failure.subject": args.subject,
      "app.failure.stage": args.kind === "tool" ? `calling ${args.subject}` : KIND_LABEL[args.kind],
      ...(story ? { "app.tool.goal": story.user_goal, "app.tool.action": story.action } : {}),
      "app.error_type": errorType,
      "app.error_cause": cause,
      "app.raw_error": code ? `[${code}] ${message}` : message,
      "app.user_impact": impact,
      "app.recommended_action": action,
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
  retrieval?: RetrievalFacts;
  /** The turn ended by asking the visitor something (eve `input.requested`). */
  askedForInput: boolean;
}

function freshTurn(): TurnState {
  return {
    steps: 0,
    toolsUsed: [],
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    askedForInput: false,
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
    return `${PARTNER_AGENT_LABEL} · Anfrage bearbeitet (${steps} ${steps === 1 ? "Schritt" : "Schritte"})`;
  }
  const q = question.replace(/\s+/g, " ").trim();
  return `${PARTNER_AGENT_LABEL} · "${q.length > 80 ? `${q.slice(0, 80)}…` : q}"`;
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
        const result = data?.result as
          | { toolName?: string; isError?: boolean; output?: unknown }
          | undefined;
        if (result?.toolName) t.toolsUsed.push(result.toolName);
        if (result?.isError) t.toolErrors += 1;
        // THE retrieval provenance. eve hands hooks the full execute() return,
        // so the search's own accounting is available without touching the
        // tool — see retrievalFactsFrom().
        if (!result?.isError && result?.toolName === "find_partners") {
          const facts = retrievalFactsFrom(result.output);
          if (facts) t.retrieval = facts;
        }
        break;
      }
      case "message.appended": {
        // First streamed content — the difference between "the widget felt
        // instant" and "the bubble sat empty for 30–60s", which is this
        // agent's most visible UX rough edge.
        if (t.firstTokenAt === undefined) t.firstTokenAt = now;
        break;
      }
      case "message.completed": {
        const text = (data?.text ?? data?.message ?? data?.content) as unknown;
        if (typeof text === "string" && text.trim() !== "") t.reply = text;
        break;
      }
      case "input.requested": {
        // A turn can end by ASKING rather than answering. Such a turn emits no
        // assistant text, so without this the summary has no output and is
        // mislabelled "answered".
        t.askedForInput = true;
        const question = data?.question ?? data?.message ?? data?.prompt;
        if (typeof question === "string" && question.trim() !== "" && !t.reply) {
          t.reply = question;
        }
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
    const searched = t.toolsUsed.includes("find_partners");
    // "answered" is too generous for a turn that ended by asking a question.
    const outcome =
      args.outcome === "answered" && t.askedForInput ? "asked-for-clarification" : args.outcome;

    /** What a reviewer needs on the TRACE row, in plain language. */
    const facts: Record<string, string> = {
      agent: PARTNER_AGENT_LABEL,
      "agent.id": args.agentName,
      "agent.role": PARTNER_AGENT_ROLE,
      outcome,
      model,
      channel: args.channelKind ?? "unknown",
      "knowledge.mode": kb?.mode ?? PARTNER_KNOWLEDGE_MODE,
      "knowledge.source": kb?.source ?? PARTNER_KNOWLEDGE_SOURCE,
      "knowledge.version_digest": kb?.digest ?? "unknown",
      "knowledge.size_chars": kb?.chars ?? "unknown",
      "knowledge.approx_tokens": kb?.approxTokens ?? "unknown",
      "knowledge.sections": kb?.sections ?? "unknown",
      "knowledge.retrieved": retrievalSummary(t.retrieval),
      // The retrieval accounting, broken out so it can be charted and filtered
      // rather than only read. Counts and canonical city names only.
      "retrieval.searched": searched ? "yes" : "no",
      "retrieval.city": t.retrieval?.requestedCity ?? "none",
      "retrieval.home_count": String(t.retrieval?.homeCount ?? 0),
      "retrieval.filled_count": String(t.retrieval?.filledCount ?? 0),
      "retrieval.cities_used": t.retrieval?.citiesUsed.join(", ") || "none",
      "retrieval.shown": String(t.retrieval?.shown ?? 0),
      "retrieval.min_met": t.retrieval ? String(t.retrieval.minMet) : "n/a",
      "retrieval.cities_exhausted": t.retrieval ? String(t.retrieval.citiesExhausted) : "n/a",
      "tools.available": PARTNER_TOOLS_AVAILABLE,
      "tools.called": t.toolsUsed.join(", ") || "none",
      "tools.errors": String(t.toolErrors),
      // CLAUDE.md §3: a search is 2 model steps, a non-search turn is 1.
      // 4 means an old tool chain regressed — chart this.
      "steps.model_calls": String(t.steps),
      "steps.expected": searched ? "2 (search turn)" : "1 (no search)",
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
          "partner-agent",
          "rag",
          "convex-directory",
          `channel:${args.channelKind ?? "unknown"}`,
          `outcome:${outcome}`,
          searched ? "searched" : "no-search",
          ...(t.retrieval && t.retrieval.filledCount > 0 ? ["gap-filled"] : []),
          ...(t.retrieval && !t.retrieval.minMet && searched ? ["below-min"] : []),
        ],
        ...traceMetadata(facts),

        // --- Observation level: the summary readable on its own -------------
        // The facts above are NOT repeated here as `app.*`. Langfuse surfaces
        // `langfuse.trace.metadata.*` on the observation too, so duplicating
        // them only doubles the metadata pane.
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
