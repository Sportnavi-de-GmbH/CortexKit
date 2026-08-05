/**
 * verify-langsmith.ts — assert, via the LangSmith API, that a live turn
 * produced a COMPLETE trace. Mirrors scripts/verify-sentry.ts for the other
 * observability backend, and implements EVE_LANGSMITH_TRACING_GUIDE.md §11
 * Step V4.
 *
 * Why an API check and not the UI: the two pipes have very different
 * latencies (hook runs land in seconds via REST, OTLP spans in minutes), so
 * eyeballing the UI too early looks identical to real data loss. This script
 * polls, so "not there yet" and "never arriving" stop being the same picture.
 *
 * Run (after `npx tsx scripts/live-check.ts ...` printed a session id):
 *   npx tsx scripts/verify-langsmith.ts <sessionId>
 * Or verify the most recent trace in the project:
 *   npx tsx scripts/verify-langsmith.ts
 */
import "../lib/load-env";

import { Client } from "langsmith";

import { LANGSMITH_EU_API_URL, langsmithEnabled, projectName } from "../lib/langsmith";

const POLL_MS = 15_000;
const DEADLINE_MS = 10 * 60_000; // OTLP ingestion has been observed up to ~10 min

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

function report(checks: Check[]): boolean {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label} — ${c.detail}`);
  return checks.every((c) => c.ok);
}

async function main() {
  if (!langsmithEnabled()) {
    console.error("LANGSMITH_API_KEY is not set — nothing to verify.");
    process.exit(1);
  }
  const sessionId = process.argv[2];
  const project = projectName();
  const client = new Client({ apiUrl: LANGSMITH_EU_API_URL, apiKey: process.env.LANGSMITH_API_KEY });

  // Stage 1: find the hook-authored root. Only hook runs expose
  // `eve.session.id` as queryable metadata — OTLP spans do not (§Step A4).
  const filter = sessionId
    ? `and(eq(metadata_key, "eve.session.id"), eq(metadata_value, "${sessionId}"))`
    : undefined;

  let root: Awaited<ReturnType<Client["readRun"]>> | undefined;
  for await (const run of client.listRuns({ projectName: project, filter, isRoot: true, limit: 5 })) {
    if (typeof run.name === "string" && run.name.startsWith("Customer Request")) {
      root = run;
      break;
    }
  }
  if (!root) {
    console.error(
      `No "Customer Request" root run found in project "${project}"${sessionId ? ` for session ${sessionId}` : ""}.`,
    );
    process.exit(1);
  }

  console.log(`root run: ${root.id}`);
  console.log(`trace:    ${root.trace_id}`);

  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    // `total_cost`/`total_tokens` are server-computed rollups the SDK's `Run`
    // type does not declare, but the API does return them.
    const current = (await client.readRun(root.id)) as Awaited<ReturnType<Client["readRun"]>> & {
      total_cost?: string | number | null;
      total_tokens?: number | null;
    };
    const meta = (current.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {};
    const inputs = (current.inputs ?? {}) as Record<string, unknown>;
    const outputs = (current.outputs ?? {}) as Record<string, unknown>;

    const children: Array<Record<string, any>> = [];
    for await (const r of client.listRuns({ projectName: project, traceId: root.trace_id })) {
      if (r.id !== root.id) children.push(r as Record<string, any>);
    }
    const llm = children.filter((r) => r.run_type === "llm");
    const tools = children.filter((r) => r.run_type === "tool");

    const checks: Check[] = [
      {
        label: "ONE trace: the summary run IS the OTLP trace root",
        ok: meta["app.trace_shape"] === "anchored" && root.id === root.trace_id,
        detail: `app.trace_shape=${String(meta["app.trace_shape"])}`,
      },
      {
        label: "root carries the user message",
        ok: typeof inputs.user_message === "string" && inputs.user_message !== "",
        detail: `${String(inputs.user_message ?? "").slice(0, 40)}…`,
      },
      {
        label: "root carries the assembled system prompt",
        ok: typeof inputs.system_prompt === "string" && inputs.system_prompt.length > 500,
        detail: `${String(inputs.system_prompt ?? "").length} chars`,
      },
      {
        label: "root carries the agent reply",
        ok: typeof outputs.agent_reply === "string" && outputs.agent_reply !== "",
        detail: `${String(outputs.agent_reply ?? "").length} chars`,
      },
      {
        label: "llm children present with token counts",
        ok: llm.length > 0 && llm.every((r) => (r.total_tokens ?? 0) > 0),
        detail: `${llm.length} llm run(s)`,
      },
      {
        label: "every llm child shows dollar cost",
        ok: llm.length > 0 && llm.every((r) => r.total_cost != null),
        detail: llm.map((r) => r.total_cost ?? "null").join(", ") || "none",
      },
      {
        label: "llm children carry prompt/completion content",
        ok: llm.some((r) => Object.keys((r.inputs ?? {}) as object).length > 0),
        detail: `${llm.filter((r) => Object.keys((r.inputs ?? {}) as object).length > 0).length}/${llm.length} with inputs`,
      },
      {
        label: "tool runs carry arguments and results",
        ok: tools.length === 0 || tools.some((r) => Object.keys((r.outputs ?? {}) as object).length > 0),
        detail: `${tools.length} tool run(s): ${tools.map((r) => r.name).join(", ")}`,
      },
      {
        label: "trace-level cost rolled up onto the root",
        ok: current.total_cost != null && Number(current.total_cost) > 0,
        detail: `total_cost=${String(current.total_cost)} total_tokens=${String(current.total_tokens)}`,
      },
    ];

    const allOk = checks.every((c) => c.ok);
    if (allOk || Date.now() > deadline) {
      console.log("");
      report(checks);
      process.exit(allOk ? 0 : 1);
    }

    const pending = checks.filter((c) => !c.ok).length;
    console.log(
      `waiting for OTLP ingestion — ${pending} check(s) still unmet, ${children.length} child run(s) so far…`,
    );
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
