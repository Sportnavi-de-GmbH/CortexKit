// API-based verification of the ORCHESTRATOR's Langfuse integration.
//
// A 2xx from the OTLP exporter proves only that the request was ENQUEUED —
// Langfuse answers on enqueue, and a backlogged pipeline still answers. The
// only honest verification reads the trace back and asserts on its STRUCTURE.
//
// Beyond the checks the sibling services run, this one asserts the things that
// only matter for a ROUTER: that the routing decision is recorded, that the
// chosen specialist is named, and — the multi-agent trap — that a delegated
// subagent's work landed in the SAME trace instead of a second orphan one.
//
// A check that cannot tell "verified OK" apart from "could not check" is worse
// than none, so this counts the assertions that ran and exits INCONCLUSIVE (3)
// when none did.
//
// ENDPOINT NOTE: the instance runs Langfuse v4 in `events_only` mode, where the
// v1 `/api/public/traces` endpoints return 404. Read via
// GET /api/public/v2/observations. Do not "fix" this back to /traces.
//
// Usage:
//   npx tsx scripts/verify-langfuse.ts <eve-session-id> [--wait-mins N]
//        [--expect-route faq|find_partners|request_human_contact|provide_booking_link|ask_question|direct_reply]
//        [--expect-failure]
import "../lib/load-env.ts";

import {
  LANGFUSE_PUBLIC_API_PATH,
  ORCHESTRATOR_LABEL,
  SPAN,
  langfuseBaseUrl,
  langfuseEnabled,
  langfuseEnvironment,
  langfuseHeaders,
  langfuseRecordIo,
} from "../lib/langfuse.ts";

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--") && !isFlagValue(a));
const expectFailure = args.includes("--expect-failure");
const expectRoute =
  args.indexOf("--expect-route") >= 0 ? args[args.indexOf("--expect-route") + 1] : undefined;
const waitMins = Number(args[args.indexOf("--wait-mins") + 1]) || 4;

function isFlagValue(a: string): boolean {
  const i = args.indexOf(a);
  return i > 0 && (args[i - 1] === "--wait-mins" || args[i - 1] === "--expect-route");
}

if (!sessionId) {
  console.error(
    "usage: npx tsx scripts/verify-langfuse.ts <eve-session-id> [--wait-mins N] [--expect-route <route>] [--expect-failure]",
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

/** The compact default omits io/usage/model, and an unrequested field is
 *  indistinguishable from an empty one — so ask for them explicitly. */
const FIELDS = "basic,time,io,metadata,model,usage,metrics,trace_context";
const EXPAND = [
  "attributes.langfuse.trace.metadata.routing.handled_by",
  "attributes.langfuse.trace.metadata.routing.traced_in",
  "attributes.langfuse.trace.metadata.agent.role",
  "attributes.langfuse.trace.metadata.partner.note",
]
  .map((k) => `&expandMetadataKeys=${encodeURIComponent(k)}`)
  .join("");

interface ObservationV2 {
  id: string;
  traceId: string;
  modelId?: string | null;
  parentObservationId: string | null;
  type: string;
  name: string | null;
  level: string;
  statusMessage?: string | null;
  environment?: string;
  sessionId?: string | null;
  traceName?: string | null;
  startTime?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown> | null;
  providedModelName?: string | null;
  usageDetails?: Record<string, number> | null;
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
    "Re-run with EVE_LF_SPAN_DEBUG=1 and read .data/langfuse-spans.log — that separates 'the exporter never saw it' from 'not ingested yet'.",
  );
  process.exit(1);
}

check("observations ingested", true, `${obs.length} observation(s)`);

// --- One request = one trace, INCLUDING delegated subagents ----------------
// THE multi-agent assertion. eve runs a delegated subagent in its own child
// session, whose spans naturally form a SECOND trace. If the stitching in
// agent/instrumentation.ts regresses, this is what catches it — and the
// symptom would be a trace that silently omits the specialist's work.
const traceIds = [...new Set(obs.map((o) => o.traceId))];
check(
  "one trace per request (subagent work included, not orphaned)",
  traceIds.length === 1,
  traceIds.length === 1
    ? traceIds[0]
    : `${traceIds.length} traces: ${traceIds.join(", ")} — a delegated subagent's spans were not re-homed onto the parent trace`,
);

const NOISE_CEILING = 45; // router + subagent + tool is legitimately bigger than a single agent
const noisy = obs.filter((o) => o.name === "network-call" || o.name === "stream-response");
check(
  "trace is lean, not transport chatter",
  obs.length <= NOISE_CEILING && noisy.length === 0,
  `${obs.length} observation(s), ${noisy.length} transport span(s)` +
    (noisy.length > 0 ? " — is LANGFUSE_TRACE_COMPLETENESS=complete set?" : ""),
);

// --- Structure -------------------------------------------------------------
const generations = obs.filter((o) => o.type === "GENERATION");
check(
  "model calls typed as GENERATION",
  generations.length > 0,
  generations.length > 0
    ? `${generations.length}`
    : `types seen: ${[...new Set(obs.map((o) => o.type))].join(", ") || "none"}`,
);

const withModel = generations.filter(
  (g) => (g.providedModelName ?? "").trim() !== "" || (g.modelId ?? "").trim() !== "",
);
check(
  "generation model resolved by Langfuse",
  withModel.length > 0,
  withModel.map((g) => g.providedModelName ?? `modelId=${g.modelId}`).join(", ") || "none",
);

const totalTokens = generations.reduce(
  (sum, g) =>
    sum +
    Object.entries(g.usageDetails ?? {}).reduce((s, [k, v]) => (k === "total" ? s : s + (v ?? 0)), 0),
  0,
);
check("non-zero token usage", totalTokens > 0, `${totalTokens} tokens`);

const cost = obs.reduce((s, o) => s + (o.totalCost ?? 0), 0);
check("cost computed by Langfuse", cost > 0, cost > 0 ? `$${cost.toFixed(6)}` : "0/null");

const aggregatorsWithUsage = obs.filter(
  (o) => o.name === SPAN.orchestrate && Object.keys(o.usageDetails ?? {}).length > 0,
);
check(
  "token usage counted once, not double-billed",
  aggregatorsWithUsage.length === 0,
  aggregatorsWithUsage.length === 0
    ? "no usage on the aggregator span"
    : `${SPAN.orchestrate} still carries usage — LANGFUSE_DEDUPE_USAGE=false?`,
);

const nested = obs.filter((o) => o.parentObservationId !== null);
check("tree, not a flat list", nested.length > 0, `${nested.length}/${obs.length} have a parent`);

const missingSession = obs.filter((o) => o.sessionId !== sessionId);
check(
  "request session id on EVERY observation (subagent spans re-keyed)",
  missingSession.length === 0,
  missingSession.length === 0
    ? `all ${obs.length} carry ${sessionId}`
    : `${missingSession.length} carry a different session: ${[...new Set(missingSession.map((o) => o.sessionId))].join(", ")}`,
);

const wantEnv = langfuseEnvironment();
const wrongEnv = obs.filter((o) => o.environment !== wantEnv);
check(
  "environment tagged",
  wrongEnv.length === 0,
  wrongEnv.length === 0 ? wantEnv : `${wrongEnv.length} mis-tagged (expected ${wantEnv})`,
);

// --- The orchestration story ----------------------------------------------
const summary = obs.find((o) => o.name === SPAN.summary);
check("turn summary emitted", summary !== undefined, summary ? summary.id : "the hook produced none");

const traceName = obs.map((o) => o.traceName).find((n) => typeof n === "string" && n !== "");
check(
  "trace name identifies the ORCHESTRATOR and the route",
  typeof traceName === "string" && traceName.includes(ORCHESTRATOR_LABEL),
  traceName ?? "no trace name",
);

const metaOf = (o: ObservationV2 | undefined): Record<string, unknown> =>
  (o?.metadata ?? {}) as Record<string, unknown>;
const meta = metaOf(summary);
/** Langfuse coerces numeric-looking metadata to numbers on ingest, so a
 *  string-only lookup reports "missing" for every count and duration. */
const metaValue = (key: string): string | undefined => {
  for (const candidate of [key, `attributes.langfuse.trace.metadata.${key}`]) {
    const v = meta[candidate];
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
};

for (const [label, key, expectation] of [
  ["routing decision recorded", "routing.selected", (v: string) => v.length > 0],
  ["chosen specialist named", "routing.handled_by", (v: string) => v.length > 0],
  ["where that work is traced", "routing.traced_in", (v: string) => v.length > 0],
  ["routing options listed", "routing.options", (v: string) => v.includes("faq")],
  ["routing latency measured", "routing.decision_ms", (v: string) => v.length > 0],
  ["delegations listed", "delegation.calls", (v: string) => v.length > 0 && v !== "none"],
  ["orchestrator identified", "agent", (v: string) => v === ORCHESTRATOR_LABEL],
  ["routing prompt version pinned", "knowledge.version_digest", (v: string) => v.length === 12],
  ["steps recorded", "steps.model_calls", (v: string) => Number(v) >= 1],
  ["duration recorded", "timing.duration_ms", (v: string) => Number(v) >= 0],
] as const) {
  const value = metaValue(key);
  check(
    label,
    value !== undefined && expectation(value),
    value === undefined ? `missing trace metadata "${key}"` : value,
  );
}

if (expectRoute) {
  check(
    `route is "${expectRoute}"`,
    metaValue("routing.selected") === expectRoute,
    metaValue("routing.selected") ?? "missing",
  );

  if (expectRoute === "faq") {
    // The FAQ specialist is a LOCAL subagent: its model call must be inside
    // this trace, and there must be MORE than one generation (router + child).
    // NOT `generations.length >= 2`: the router alone makes two calls (decide,
    // then relay), so a count check PASSES while the specialist's execution sits
    // in a separate orphan trace — it did, on the first live run. Assert on the
    // AGENT IDENTITY instead, which is the thing that actually distinguishes them.
    const agentNames = new Set(
      obs
        .map((o) => {
          const m = metaOf(o);
          return (m["attributes.gen_ai.agent.name"] ?? m["gen_ai.agent.name"]) as string | undefined;
        })
        .filter((n): n is string => typeof n === "string"),
    );
    check(
      "the SPECIALIST's own execution is inside this trace (not an orphan)",
      agentNames.size >= 2,
      agentNames.size >= 2
        ? `agents present: ${[...agentNames].join(", ")}`
        : `only ${[...agentNames].join(", ") || "none"} — the subagent's spans are in a different trace`,
    );
    check(
      "delegation to the subagent is visible",
      (metaValue("delegation.child_sessions") ?? "none") !== "none",
      metaValue("delegation.child_sessions") ?? "missing",
    );
    // Runtime-context values arrive namespaced by the AI SDK, so the label can
    // land under any of these spellings. Checking only the bare key reported a
    // false FAILURE while `faq-subagent` was sitting on the spans all along.
    const subagentSpans = obs.filter((o) => {
      const m = metaOf(o);
      const label =
        m["app.agent.label"] ??
        m["attributes.app.agent.label"] ??
        m["attributes.ai.settings.context.app.agent.label"];
      return typeof label === "string" && label.includes("subagent");
    });
    check(
      "specialist spans are labelled as the subagent, not the router",
      subagentSpans.length > 0,
      subagentSpans.length > 0
        ? `${subagentSpans.length} span(s) labelled`
        : "no span carries app.agent.label=*-subagent — who did what is unanswerable",
    );
  }

  if (expectRoute === "find_partners") {
    // The partner specialist is ANOTHER SERVICE with its OWN Langfuse project.
    // This trace cannot contain its detail; it must point at it instead.
    const pid = metaValue("partner.session_id");
    check(
      "cross-project link to the Partner project recorded",
      pid !== undefined && pid.length > 0,
      pid ?? "missing partner.session_id — the Partner project trace cannot be found from here",
    );
    check(
      "partner project named on the trace",
      (metaValue("partner.project") ?? "").includes("Partner"),
      metaValue("partner.project") ?? "missing",
    );
    check(
      "partner actually queried its database (work-actually-performed)",
      metaValue("partner.search_performed") !== "false",
      metaValue("partner.search_performed") ?? "not reported",
    );
  }
}

const empty = obs.filter(
  (o) => (o.input === null || o.input === undefined) && (o.output === null || o.output === undefined),
);
check(
  "no empty observations",
  empty.length === 0,
  empty.length === 0 ? `all ${obs.length} carry input and/or output` : `${empty.length} empty: ${empty.map((o) => o.name).join(", ")}`,
);

const purposeOf = (o: ObservationV2): unknown =>
  metaOf(o)["step.purpose"] ?? metaOf(o)["attributes.step.purpose"];
const withoutPurpose = obs.filter((o) => !o.name?.startsWith("failure:") && purposeOf(o) === undefined);
check(
  "every stage states its purpose",
  withoutPurpose.length === 0,
  withoutPurpose.length === 0 ? "present on every stage" : `missing on: ${withoutPurpose.map((o) => o.name).join(", ")}`,
);

// Tool observations are excluded on purpose: Langfuse names a TOOL observation
// from `gen_ai.tool.name`, overriding the span name, and for a tool the real
// name IS the readable name.
const leaked = obs.filter((o) =>
  /^(workflow\.|step\.|step \d|fetch |invoke_agent|chat |execute_tool)/.test(o.name ?? ""),
);
check(
  "no framework span names leaked to the reader",
  leaked.length === 0,
  leaked.length === 0 ? obs.map((o) => o.name).join(" · ") : leaked.map((o) => o.name).join(", "),
);

// --- Errors ----------------------------------------------------------------
const errors = obs.filter((o) => o.level === "ERROR");
if (expectFailure) {
  check(
    "failure captured as ERROR",
    errors.length > 0,
    errors.map((e) => `${e.name}: ${e.statusMessage ?? ""}`).join(" | ") || "no ERROR observation",
  );
  const diagnosed = errors.filter((e) => {
    const out = typeof e.output === "string" ? e.output : JSON.stringify(e.output ?? "");
    return out.includes("recommended_action") && out.includes("failed_route");
  });
  check(
    "failure names the route that failed and what to do",
    diagnosed.length > 0,
    diagnosed.length > 0 ? "carries route + cause + action" : "raw message only",
  );
} else {
  check(
    "no unexpected errors",
    errors.length === 0,
    errors.length === 0 ? "clean" : errors.map((e) => `${e.name}: ${e.statusMessage ?? ""}`).join(" | "),
  );
}

// --- Project hygiene, scoped in time ---------------------------------------
// Session-scoped checks CANNOT see orphan traces: they carry no session, so
// they never appear in the query above. Scoped to this run, or it would report
// history a since-fixed build wrote.
try {
  const since = obs.map((o) => o.startTime).filter((t): t is string => typeof t === "string").sort()[0];
  const recent = await get<{ data: ObservationV2[] }>(
    `/v2/observations?fields=basic,time,trace_context&limit=100`,
  );
  const all = (recent.data ?? []).filter((o) => !since || (o.startTime ?? "") >= since);
  const orphans = all.filter((o) => !o.sessionId);
  check(
    "no session-less orphan traces from this run",
    orphans.length === 0,
    orphans.length === 0
      ? `all ${all.length} observation(s) since this run belong to a session`
      : `${orphans.length}/${all.length} orphaned (${[...new Set(orphans.map((o) => o.name))].join(", ")})`,
  );
} catch (err) {
  check("project hygiene readable", false, `could not read recent observations: ${(err as Error).message}`);
}

// --- Report ----------------------------------------------------------------
if (traceIds[0]) {
  console.log(`\ntrace: ${langfuseBaseUrl()}/project/<projectId>/traces/${traceIds[0]}\n`);
}
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label.padEnd(56)} ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (!langfuseRecordIo()) {
  console.log("note: LANGFUSE_RECORD_IO is off, so conversation text was deliberately withheld.");
}
if (checks.length === 0) {
  console.error("INCONCLUSIVE — no assertion ran.");
  process.exit(3);
}
process.exit(failed.length === 0 ? 0 : 1);
