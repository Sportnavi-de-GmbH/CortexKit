// API-based verification of the LangSmith integration (guide §11, Step V4).
// Never eyeball the UI inside the ingestion window — hook runs arrive in
// seconds, OTLP spans take MINUTES; this script polls with generous windows
// and asserts the §11 conditions:
//
//   1. exactly ONE trace for the session (root run id = trace id);
//   2. root has inputs.user_message (+ inputs.system_prompt when
//      LANGSMITH_RECORD_IO=true) and outputs.agent_reply;
//   3. ≥1 child with run_type=llm, non-zero tokens, and — after ingestion —
//      total_cost != null;
//   4. tool runs appear with run_type=tool (when a tool was used);
//   5. with --expect-failure: a story-form failure run with status=error.
//
// Usage:
//   npx tsx scripts/verify-langsmith.ts <sessionId> [--expect-failure] [--wait-mins N]
import "../lib/load-env.ts";

import { createLangsmithClient, projectName, recordIo } from "../lib/langsmith.ts";

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--"));
const expectFailure = args.includes("--expect-failure");
const waitMins = Number(args[args.indexOf("--wait-mins") + 1]) || 12;

if (!sessionId) {
  console.error("usage: npx tsx scripts/verify-langsmith.ts <sessionId> [--expect-failure] [--wait-mins N]");
  process.exit(2);
}

const client = createLangsmithClient();
if (!client) {
  console.error("LANGSMITH_API_KEY missing — nothing to verify.");
  process.exit(2);
}

const project = projectName();
const wantSystemPrompt = recordIo();

interface RunLite {
  id: string;
  trace_id: string;
  name: string;
  run_type: string;
  error?: string | null;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  total_cost?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  extra?: { metadata?: Record<string, unknown> };
}

async function collect(params: Record<string, unknown>): Promise<RunLite[]> {
  const out: RunLite[] = [];
  // Resolve the project by NAME at query time — never by stored id (§8.2:
  // trace wipes recreate projects under new ids).
  for await (const run of client!.listRuns({ projectName: project, ...params } as never)) {
    out.push(run as unknown as RunLite);
  }
  return out;
}

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

async function inspect(): Promise<Check[]> {
  const bySession = await collect({
    filter: `and(eq(metadata_key, "eve.session.id"), eq(metadata_value, "${sessionId}"))`,
  });
  if (bySession.length === 0) {
    return [{ label: "runs for session", ok: false, detail: "no runs found yet" }];
  }

  const traceIds = [...new Set(bySession.map((r) => r.trace_id))];
  const checks: Check[] = [];
  checks.push({
    label: "one trace per request",
    ok: traceIds.length === 1,
    detail: `trace ids: ${traceIds.join(", ")}`,
  });

  const trace = await collect({ traceId: traceIds[0] });
  const root = trace.find((r) => r.id === r.trace_id);
  const rootOk =
    !!root &&
    root.name.startsWith("Customer Request") &&
    typeof root.inputs?.user_message === "string" &&
    typeof (root.outputs as { agent_reply?: unknown })?.agent_reply === "string";
  checks.push({
    label: "root = summary run with real IO",
    ok: rootOk,
    detail: root ? `root "${root.name}"` : "no root run (id == trace_id) found",
  });

  if (wantSystemPrompt) {
    const sp = root?.inputs?.system_prompt;
    checks.push({
      label: "system prompt on root (LANGSMITH_RECORD_IO=true)",
      ok: typeof sp === "string" && sp.length > 0,
      detail: typeof sp === "string" ? `${sp.length} chars` : "missing",
    });
  }

  const llm = trace.filter((r) => r.run_type === "llm");
  const llmTokensOk = llm.some((r) => (r.prompt_tokens ?? 0) > 0);
  checks.push({
    label: "llm children with tokens (OTLP ingested)",
    ok: llm.length > 0 && llmTokensOk,
    detail: `${llm.length} llm runs, tokens ${llm.map((r) => r.prompt_tokens ?? 0).join("/") || "-"}`,
  });
  checks.push({
    label: "cost on llm runs",
    ok: llm.length > 0 && llm.every((r) => r.total_cost != null),
    detail: `total_cost: ${llm.map((r) => r.total_cost ?? "null").join(", ") || "-"}`,
  });

  // Tool runs are informational, never required: the model may answer
  // WITHOUT calling a tool at all (verified live: "divide 1 by 0" was
  // answered from knowledge — no tool call, no tool span, no failure run).
  // Force the call in the prompt when testing failure capture.
  const tools = trace.filter((r) => r.run_type === "tool");
  if (tools.length > 0) {
    checks.push({
      label: "tool runs typed tool",
      ok: true,
      detail: tools.map((r) => r.name).join(", "),
    });
  }

  if (expectFailure) {
    const failure = trace.find((r) => r.error != null && r.name.includes("Failed:"));
    checks.push({
      label: "story-form failure run (status=error)",
      ok: !!failure,
      detail: failure ? `"${failure.name}"` : "not found in trace",
    });
  }

  return checks;
}

const deadline = Date.now() + waitMins * 60_000;
console.log(`Verifying session ${sessionId} in project "${project}" (EU), waiting up to ${waitMins} min…`);

for (;;) {
  const checks = await inspect();
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? "✅" : "⏳"} ${c.label} — ${c.detail}`);
  if (failed.length === 0) {
    console.log("ALL CHECKS PASSED");
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`TIMED OUT with ${failed.length} unmet check(s). Remember: OTLP ingestion takes minutes; re-run later before assuming loss.`);
    process.exit(1);
  }
  console.log("  …waiting 30s (OTLP ingestion takes minutes)\n");
  await new Promise((r) => setTimeout(r, 30_000));
}
