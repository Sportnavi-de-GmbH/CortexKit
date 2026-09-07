// API-based verification of the Langfuse integration.
//
// WHY THIS EXISTS: a 2xx from the OTLP exporter proves only that the request
// was ENQUEUED. Langfuse answers on enqueue, and a backlogged pipeline still
// answers. The only honest verification reads the trace back and asserts on
// its STRUCTURE — nesting, model, usage, session, environment, level — not on
// the fact that something arrived.
//
// A check that cannot tell "verified OK" apart from "could not check" is worse
// than none, so this counts the assertions that actually ran and exits
// INCONCLUSIVE (3) when none did.
//
// ENDPOINT NOTE (learned the hard way, 2026-08-12): this instance runs
// Langfuse v4 in `events_only` mode, where the v1 `/api/public/traces`
// endpoints return 404 — "read span and trace data via
// GET /api/public/v2/observations". Do not "fix" this back to /traces.
//
// Usage:
//   npx tsx scripts/verify-langfuse.ts <eve-session-id> [--wait-mins N] [--expect-failure]
import "../lib/load-env.ts";

import {
  LANGFUSE_PUBLIC_API_PATH,
  SPAN,
  langfuseBaseUrl,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  langfuseRecordIo,
} from "../lib/langfuse.ts";

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--"));
const expectFailure = args.includes("--expect-failure");
const waitMins = Number(args[args.indexOf("--wait-mins") + 1]) || 4;

if (!sessionId) {
  console.error(
    "usage: npx tsx scripts/verify-langfuse.ts <eve-session-id> [--wait-mins N] [--expect-failure]",
  );
  process.exit(2);
}

if (!langfuseEnabled()) {
  console.error(
    "Langfuse is not configured (need LANGFUSE_BASE_URL + LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY).",
  );
  console.error("INCONCLUSIVE — nothing was verified.");
  process.exit(3);
}

const base = `${langfuseBaseUrl()}${LANGFUSE_PUBLIC_API_PATH}`;
const headers = langfuseHeaders();

/** Field groups the v2 API needs asked for explicitly — the compact default
 *  omits io, usage and model, and an absent field is indistinguishable from an
 *  empty one if you don't request it. */
const FIELDS = "basic,time,io,metadata,model,usage,metrics,trace_context";

/** Trace-metadata keys are nested under `attributes.…` in the API response, so
 *  ask for the full values rather than the 200-char truncation. */
const EXPAND = [
  "attributes.langfuse.trace.metadata.knowledge.source",
  "attributes.langfuse.trace.metadata.knowledge.retrieved",
  "attributes.langfuse.trace.metadata.agent.role",
].map((k) => `&expandMetadataKeys=${encodeURIComponent(k)}`).join("");

interface ObservationV2 {
  id: string;
  traceId: string;
  modelId?: string | null;
  parentObservationId: string | null;
  isRootObservation?: boolean;
  type: string;
  name: string | null;
  level: string;
  statusMessage?: string | null;
  environment?: string;
  sessionId?: string | null;
  traceName?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown> | null;
  providedModelName?: string | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
  totalCost?: number | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function fetchObservations(): Promise<ObservationV2[]> {
  const page = await get<{ data: ObservationV2[] }>(
    `/v2/observations?sessionId=${encodeURIComponent(sessionId!)}&fields=${FIELDS}&limit=100${EXPAND}`,
  );
  return page.data ?? [];
}

/** Poll until the session's observations show up. Ingestion is asynchronous,
 *  so an empty first read means "not yet", never "broken". */
async function waitForObservations(): Promise<ObservationV2[]> {
  const deadline = Date.now() + waitMins * 60_000;
  let waited = 0;
  for (;;) {
    const found = await fetchObservations();
    if (found.length > 0) return found;
    if (Date.now() > deadline) return [];
    waited += 5;
    process.stdout.write(`\rwaiting for ingestion … ${waited}s`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const check = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });

const obs = await waitForObservations();
process.stdout.write("\r".padEnd(40) + "\r");

if (obs.length === 0) {
  console.error(`No observations found for session ${sessionId} within ${waitMins} min.`);
  console.error(
    "Either nothing was exported, or the turn never ran. Check .data/spans.log with EVE_LF_SPAN_DEBUG=1.",
  );
  process.exit(1);
}

check("observations ingested", true, `${obs.length} observation(s)`);

const traceIds = [...new Set(obs.map((o) => o.traceId))];
check("one trace per request", traceIds.length === 1, `${traceIds.length}: ${traceIds.join(", ")}`);

// Regression guard. Exporting eve's transport spans once made a single FAQ
// turn 112 observations (89 of them `fetch`/`stream` chatter) — a 14× cost
// multiplier on a per-observation backend, and unreadable. Volume is a
// quality signal, so assert on it.
const NOISE_CEILING = 30;
const noisy = obs.filter((o) => o.name === "network-call" || o.name === "stream-response");
check(
  "trace is lean, not transport chatter",
  obs.length <= NOISE_CEILING && noisy.length === 0,
  `${obs.length} observation(s), ${noisy.length} transport span(s)` +
    (noisy.length > 0 ? " — is LANGFUSE_TRACE_COMPLETENESS=complete set?" : ""),
);

// --- Structure, not existence ---------------------------------------------
const generations = obs.filter((o) => o.type === "GENERATION");
check(
  "model call typed as GENERATION",
  generations.length > 0,
  generations.length > 0
    ? `${generations.length}: ${generations.map((g) => g.name ?? "?").join(", ")}`
    : `types seen: ${[...new Set(obs.map((o) => o.type))].join(", ") || "none"}`,
);

// `providedModelName` is the name as sent; `modelId` is Langfuse's resolved
// pricing entry. This instance returns only the latter, and the resolved id is
// what actually drives cost — so either counts as "Langfuse knows the model".
const withModel = generations.filter(
  (g) => (g.providedModelName ?? "").trim() !== "" || (g.modelId ?? "").trim() !== "",
);
check(
  "generation model resolved by Langfuse",
  withModel.length > 0,
  withModel.map((g) => g.providedModelName ?? `modelId=${g.modelId}`).join(", ") ||
    "no model on any generation — Langfuse cannot price it",
);

const totalTokens = generations.reduce(
  (sum, g) =>
    sum +
    Object.entries(g.usageDetails ?? {}).reduce(
      (s, [k, v]) => (k === "total" ? s : s + (v ?? 0)),
      0,
    ),
  0,
);
check("non-zero token usage", totalTokens > 0, `${totalTokens} tokens across generations`);

const cost = obs.reduce((s, o) => s + (o.totalCost ?? 0), 0);
check(
  "cost computed by Langfuse",
  cost > 0,
  cost > 0 ? `$${cost.toFixed(6)}` : "0/null — model missing from the pricing table, or usage absent",
);

const nested = obs.filter((o) => o.parentObservationId !== null);
check(
  "tree, not a flat list",
  nested.length > 0,
  `${nested.length}/${obs.length} observation(s) have a parent`,
);

const agents = obs.filter((o) => o.type === "AGENT");
check(
  "eve turn typed as AGENT (drives the Agent Graph)",
  agents.length > 0,
  agents.map((a) => a.name ?? "?").join(", ") || "no AGENT observation",
);

// --- The attributes that make traces findable ------------------------------
const missingSession = obs.filter((o) => o.sessionId !== sessionId);
check(
  "session id on EVERY observation",
  missingSession.length === 0,
  missingSession.length === 0
    ? `all ${obs.length} carry ${sessionId}`
    : `${missingSession.length} without it: ${missingSession.map((o) => o.name ?? o.id).join(", ")}`,
);

const wantEnv = langfuseEnvironment();
const wrongEnv = obs.filter((o) => o.environment !== wantEnv);
check(
  "environment tagged",
  wrongEnv.length === 0,
  wrongEnv.length === 0
    ? wantEnv
    : `${wrongEnv.length} tagged ${[...new Set(wrongEnv.map((o) => o.environment))].join(",")} (expected ${wantEnv})`,
);

// --- The turn summary: what a reviewer sees at a glance ---------------------
const summary = obs.find((o) => o.name === SPAN.summary);
check("turn summary emitted", summary !== undefined, summary ? summary.id : "the hook produced none");

if (langfuseRecordIo()) {
  const hasIo = summary?.input !== undefined && summary?.input !== null;
  check(
    "turn input/output readable",
    hasIo,
    hasIo ? "present" : `${SPAN.summary} has no input — the trace list will be unreadable`,
  );
} else {
  check(
    "content capture off (as configured)",
    true,
    "LANGFUSE_RECORD_IO is not true — prompts/completions deliberately withheld",
  );
}

// --- Readability: can someone answer the questions from the trace alone? ----
// This is the actual acceptance criterion. Each check maps to one thing a
// reviewer must not have to read the code to learn.
const traceName = obs.map((o) => o.traceName).find((n) => typeof n === "string" && n !== "");
check(
  "trace name says which agent and what was asked",
  typeof traceName === "string" && traceName.includes("KB-Agent"),
  traceName ?? "no trace name — the trace list shows an opaque id",
);

const metaOf = (o: ObservationV2 | undefined): Record<string, unknown> =>
  (o?.metadata ?? {}) as Record<string, unknown>;
const meta = metaOf(summary);
/** Langfuse coerces numeric-looking metadata to real numbers on ingest, so a
 *  string-only lookup silently reports "missing" for every count and duration.
 *  (Cost me two false FAILs on 2026-08-13.) */
const metaValue = (key: string): string | undefined => {
  for (const candidate of [key, `attributes.langfuse.trace.metadata.${key}`]) {
    const v = meta[candidate];
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
};

for (const [label, key, expectation] of [
  ["knowledge source named", "knowledge.source", (v: string) => v.includes("instructions.md")],
  ["knowledge version pinned", "knowledge.version_digest", (v: string) => v.length === 12],
  ["retrieval behaviour stated", "knowledge.retrieved", (v: string) => v.length > 0],
  ["tool policy stated", "tools.available", (v: string) => v.length > 0],
  ["tools actually called listed", "tools.called", (v: string) => v.length > 0],
  ["steps recorded", "steps.model_calls", (v: string) => Number(v) >= 0],
  ["duration recorded", "timing.duration_ms", (v: string) => Number(v) >= 0],
] as const) {
  const value = metaValue(key);
  check(
    label,
    value !== undefined && expectation(value),
    value === undefined ? `missing trace metadata "${key}"` : value,
  );
}

// Every stage must speak for itself. Measured before this was enforced: 3 of 6
// observations had input AND output null, including the trace root.
const empty = obs.filter(
  (o) =>
    (o.input === null || o.input === undefined) && (o.output === null || o.output === undefined),
);
check(
  "no empty observations",
  empty.length === 0,
  empty.length === 0
    ? `all ${obs.length} carry input and/or output`
    : `${empty.length} empty: ${empty.map((o) => o.name).join(", ")}`,
);

// Unmapped span attributes land in observation metadata under an `attributes.`
// prefix, so look under both spellings.
const purposeOf = (o: ObservationV2): unknown =>
  metaOf(o)["step.purpose"] ?? metaOf(o)["attributes.step.purpose"];
const withoutPurpose = obs.filter(
  (o) => !o.name?.startsWith("failure:") && purposeOf(o) === undefined,
);
check(
  "every stage states its purpose",
  withoutPurpose.length === 0,
  withoutPurpose.length === 0
    ? "purpose present on every stage"
    : `missing on: ${withoutPurpose.map((o) => o.name).join(", ")}`,
);

// The knowledge base must be visible on the call it produced, not buried on a
// wrapper as an escaped blob.
const gen = generations[0];
const genInput = typeof gen?.input === "string" ? gen.input : JSON.stringify(gen?.input ?? "");
check(
  "model call shows the knowledge it was given",
  genInput.includes("knowledge_base") && genInput.includes("version_digest"),
  genInput.includes("knowledge_base")
    ? `${genInput.length} chars, structured`
    : "the generation's input does not show the knowledge base",
);

// The whole point of renaming: no framework internals should reach a reader.
const leaked = obs.filter((o) => /^(workflow\.|step\.|fetch |invoke_agent|chat )/.test(o.name ?? ""));
check(
  "no framework span names leaked to the reader",
  leaked.length === 0,
  leaked.length === 0
    ? obs.map((o) => o.name).join(" · ")
    : leaked.map((o) => o.name).join(", "),
);

// --- Errors ----------------------------------------------------------------
const errors = obs.filter((o) => o.level === "ERROR");
if (expectFailure) {
  check(
    "failure captured as ERROR",
    errors.length > 0,
    errors.map((e) => `${e.name}: ${e.statusMessage ?? ""}`).join(" | ") || "no ERROR observation",
  );
} else {
  check(
    "no unexpected errors",
    errors.length === 0,
    errors.length === 0
      ? "clean"
      : errors.map((e) => `${e.name}: ${e.statusMessage ?? ""}`).join(" | "),
  );
}

// --- Report ----------------------------------------------------------------
if (traceIds[0]) {
  console.log(`\ntrace: ${langfuseBaseUrl()}/project/<projectId>/traces/${traceIds[0]}\n`);
}
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label.padEnd(38)} ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (checks.length === 0) {
  console.error("INCONCLUSIVE — no assertion ran.");
  process.exit(3);
}
process.exit(failed.length === 0 ? 0 : 1);
