// Runs a rate-limit-aware evaluation of the Navio agent against a LangSmith
// dataset using the deterministic baseline evaluators, LLM judges and
// performance/cost metrics (lib/eval/*).
//
// TWO-PHASE DESIGN (the key to correct pacing AND clean latency):
//
//  Phase A — EXECUTE: a plain serial loop calls the agent for every example,
//  gated by the TPM+RPM pacers. No LangSmith spans are involved, so pacing
//  waits pollute nothing; spacing is guaranteed because the loop is ours.
//  Answers, per-turn latency, TTFT and token usage are recorded.
//
//  Phase B — EVALUATE: evaluate() replays the records. The target replays
//  each turn inside a traceable llm child whose duration equals the MEASURED
//  call time and whose outputs carry usage_metadata + ls_model_name — so the
//  LangSmith root Latency column shows pure response time and the native
//  token/cost columns populate. Judges (real model calls) run in this phase,
//  paced through the same budgets.
//
//  Why not pace inside evaluate()? All simpler placements failed in practice:
//  in-target pacing pollutes root latency; async-generator data is drained
//  eagerly; trailing-evaluator pacing does not gate targets (the runner
//  schedules them independently). See the guide's troubleshooting section.
//
// Prerequisites: the eve dev server is running (npm run dev — note the REAL
// port) and .env.local carries LangSmith + Azure vars, LANGSMITH_RECORD_IO=true.
//
// Usage:
//   EVE_HOST=http://127.0.0.1:<port> npm run eval:run                # full dataset (30)
//   EVAL_SPLIT=smoke EVE_HOST=... npm run eval:run                   # 5-sample plumbing run
//   EVAL_LIMIT=2 EVE_HOST=... npm run eval:run                       # quick harness check
import "../lib/load-env.ts";

import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { traceable } from "langsmith/traceable";
import { Client as EveClient } from "eve/client";

import { ensureDataset } from "../lib/eval/dataset-upload.ts";
import { baselineEvaluators } from "../lib/eval/evaluators.ts";
import { judgeKeys, makeJudgeEvaluators } from "../lib/eval/judges.ts";
import {
  computeCostUsd,
  extractTtftMs,
  extractUsage,
  metricEvaluators,
  type TurnEvent,
  type Usage,
} from "../lib/eval/metrics.ts";
import { TokenBucketPacer, withRetry } from "../lib/eval/rate-limit.ts";

// --- configuration (env-overridable, defaults from measured project numbers) ---
const DATASET = process.env.EVAL_DATASET ?? "navio-kb-testing-final-response-v2";
const SPLIT = process.env.EVAL_SPLIT; // e.g. "smoke" | "core"; unset = whole dataset
const LIMIT = Number(process.env.EVAL_LIMIT) || undefined;
const TPM_BUDGET = Number(process.env.EVAL_TPM_BUDGET) || 50_000;
const TOKENS_PER_REQUEST = Number(process.env.EVAL_TOKENS_PER_REQUEST) || 21_000; // ~20.2k measured per turn, 2026-07-27
// Azure pairs every TPM quota with an RPM quota (convention: ~6 RPM per 1000
// TPM — verify YOUR deployment's number in the Azure portal). The binding
// ceiling is the tighter of the two (SOP §9).
const RPM_BUDGET = Number(process.env.EVAL_RPM_BUDGET) || Math.max(1, Math.round((TPM_BUDGET / 1000) * 6));
const BINDING_REQS_PER_MIN = Math.max(1, Math.min(RPM_BUDGET, Math.floor(TPM_BUDGET / TOKENS_PER_REQUEST)));
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY) || Math.min(8, BINDING_REQS_PER_MIN);
const MAX_ATTEMPTS = Number(process.env.EVAL_MAX_ATTEMPTS) || 6;
const EXPERIMENT_PREFIX = process.env.EVAL_EXPERIMENT_PREFIX ?? "navio-kb-baseline";
const EVE_HOST = process.env.EVE_HOST ?? "http://127.0.0.1:3000";
// LLM judges: "all" (default), "none", or a comma list of judge keys.
// They currently share the agent's deployment, so each call is metered
// through the same pacers (EVAL_JUDGE_TOKENS estimate per call).
const JUDGES = (process.env.EVAL_JUDGES ?? "all").trim();
const JUDGE_TOKENS = Number(process.env.EVAL_JUDGE_TOKENS) || 2_500;
// Azure gpt-4o-mini list prices per 1M tokens (the deployment this project
// runs) — verify against the current price list; override via env when prices
// change.
const PRICE_IN_PER_M = Number(process.env.EVAL_PRICE_IN_PER_M) || 0.15;
const PRICE_OUT_PER_M = Number(process.env.EVAL_PRICE_OUT_PER_M) || 0.6;
const PRICE_CACHED_PER_M = Number(process.env.EVAL_PRICE_CACHED_PER_M) || 0.075;

for (const key of ["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT"]) {
  if (!process.env[key]) throw new Error(`${key} is not set — copy .env.example to .env.local and fill it in.`);
}
if ((process.env.LANGSMITH_RECORD_IO ?? "").toLowerCase() !== "true") {
  console.warn("⚠ LANGSMITH_RECORD_IO is not 'true' — eval traces will be content-redacted (SOP §11 pre-flight).");
}

const gitSha = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const eve = new EveClient({ host: EVE_HOST });
const tpmPacer = new TokenBucketPacer(TPM_BUDGET); // tokens per rolling minute
const rpmPacer = new TokenBucketPacer(RPM_BUDGET); // requests per rolling minute
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class RetryableTurnError extends Error {}

interface TurnResult {
  status?: string;
  message?: string;
  sessionId?: string;
  events?: TurnEvent[];
  [k: string]: unknown;
}

const MODEL_NAME = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "gpt-4o-mini";

interface TurnRecord {
  input: string;
  output: string;
  latencyMs: number;
  usage: Usage;
}

interface ExampleRecord {
  answer: string;
  failed: boolean;
  error?: string;
  sessionId?: string;
  turns: TurnRecord[];
  metrics: {
    latency_ms: number | null;
    ttft_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cost_usd: number | null;
  };
}

type Inputs = { messages: Array<{ role: string; content: string }> };
const recordKey = (inputs: Inputs) => JSON.stringify(inputs?.messages ?? []);

// --- Phase A: execute the agent, serially and paced -------------------------
// One example = one fresh session; multi-turn samples replay every user
// message in order (each is a full model call — the pacers gate each one).
async function executeAgent(inputs: Inputs): Promise<ExampleRecord> {
  const session = eve.session();
  let final: TurnResult | undefined;
  let sessionId: string | undefined;
  let latencyMs = 0;
  let ttftMs: number | null = null;
  const totals: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const turns: TurnRecord[] = [];

  for (const m of (inputs.messages ?? []).filter((m) => m.role === "user")) {
    await rpmPacer.acquire(1);
    await tpmPacer.acquire(TOKENS_PER_REQUEST);
    const t0 = Date.now();
    const result = await withRetry(
      async () => {
        const resp = await session.send(m.content);
        sessionId = sessionId ?? (resp as { sessionId?: string }).sessionId;
        const r = (await resp.result()) as unknown as TurnResult;
        // eve surfaces model-call failures as status=failed, not as throws.
        // Deterministic failures (content_filter / jailbreak shield) pass
        // through as data — retrying them only burns quota. Everything else
        // (throttles, transient model errors) is promoted to an error so
        // withRetry backs off and tries again.
        if (r.status === "failed") {
          const errText = JSON.stringify(r);
          if (!/content_filter|content management policy|jailbreak/i.test(errText)) {
            // Keep the TAIL of the event stream — that's where the failure
            // event lives; the head is just session/turn bookkeeping.
            throw new RetryableTurnError(errText.slice(-600));
          }
        }
        return r;
      },
      {
        attempts: MAX_ATTEMPTS,
        isRetryable: (e) =>
          e instanceof RetryableTurnError ||
          /429|rate limit|too many requests|fetch failed|econnreset|etimedout|socket hang up|5\d\d/i.test(
            String((e as Error)?.message ?? e),
          ),
        onRetry: (attempt, delay, err) =>
          console.warn(`  retry ${attempt} in ${Math.round(delay / 1000)}s: ${String((err as Error)?.message).slice(0, 120)}`),
      },
    );
    const turnLatency = Date.now() - t0;
    latencyMs += turnLatency;
    final = result;
    const events = (result.events ?? []) as TurnEvent[]; // events are PER TURN (client docs)
    const usage = extractUsage(events);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    ttftMs = extractTtftMs(events) ?? ttftMs;
    turns.push({
      input: m.content,
      output: typeof result.message === "string" ? result.message : "",
      latencyMs: turnLatency,
      usage,
    });
  }

  const failed = final?.status === "failed" || typeof final?.message !== "string";
  const measured = totals.inputTokens > 0 || totals.outputTokens > 0;
  return {
    answer: typeof final?.message === "string" ? final.message : "",
    failed,
    // Tail, not head: the failure event sits at the END of the event stream.
    error: failed ? JSON.stringify(final ?? {}).slice(-600) : undefined,
    sessionId,
    turns,
    metrics: {
      latency_ms: latencyMs || null,
      ttft_ms: ttftMs,
      input_tokens: measured ? totals.inputTokens : null,
      output_tokens: measured ? totals.outputTokens : null,
      cache_read_tokens: measured ? totals.cacheReadTokens : null,
      cost_usd: measured ? computeCostUsd(totals, PRICE_IN_PER_M, PRICE_OUT_PER_M, PRICE_CACHED_PER_M) : null,
    },
  };
}

// --- Phase B target: replay records into clean, fully-priced traces ---------
const records = new Map<string, ExampleRecord>();

async function runAgent(inputs: Inputs) {
  const rec = records.get(recordKey(inputs));
  if (!rec) throw new Error(`No execution record for inputs: ${recordKey(inputs).slice(0, 120)}`);

  const replayTurn = traceable(
    async (_userMessage: string, turn: TurnRecord) => {
      await sleep(turn.latencyMs); // replay the MEASURED duration → span = true response time
      return {
        output: turn.output,
        usage_metadata: {
          input_tokens: turn.usage.inputTokens,
          output_tokens: turn.usage.outputTokens,
          total_tokens: turn.usage.inputTokens + turn.usage.outputTokens,
          input_token_details: { cache_read: turn.usage.cacheReadTokens },
        },
      };
    },
    {
      run_type: "llm",
      name: MODEL_NAME,
      metadata: { ls_model_name: MODEL_NAME, ls_provider: "azure" },
      processInputs: (i) => ({ input: (i as { _userMessage?: string })._userMessage }),
    },
  );

  for (const turn of rec.turns) await replayTurn(turn.input, turn);

  return {
    answer: rec.answer,
    failed: rec.failed,
    error: rec.error,
    sessionId: rec.sessionId,
    metrics: rec.metrics,
  };
}

// --- resolve data ----------------------------------------------------------
// Two field-proven defenses (2026-07-27, guide troubleshooting section):
//  1. Self-healing pre-flight: datasets have repeatedly VANISHED from this
//     LangSmith EU workspace within ~an hour of upload. The repo JSON is the
//     source of truth, so a missing dataset is restored automatically.
//  2. ALWAYS fetch the examples ourselves and hand evaluate() the array —
//     the runner's internal by-name resolution failed with "Dataset[…] not
//     found" even while the dataset was resolvable. The array path is the
//     one proven reliable.
async function resolveData() {
  const client = new Client();
  const specFile = resolvePath(process.cwd(), `evals/datasets/${DATASET}.json`);
  const state = await ensureDataset(client, specFile);
  if (state === "restored") {
    console.warn(`⚠ Dataset "${DATASET}" was missing remotely — restored from ${specFile} (see guide troubleshooting).`);
  }
  const examples = [];
  for await (const e of client.listExamples({ datasetName: DATASET, ...(SPLIT ? { splits: [SPLIT] } : {}) })) {
    examples.push(e);
    if (LIMIT && examples.length >= LIMIT) break;
  }
  if (examples.length === 0) throw new Error(`No examples for dataset="${DATASET}" split="${SPLIT ?? "*"}".`);
  return examples;
}

// Judge selection: shared-deployment judge calls go through the same pacers.
const judgeNames =
  JUDGES === "all" ? ("all" as const) : JUDGES === "none" ? [] : JUDGES.split(",").map((s) => s.trim()).filter(Boolean);
const unknownJudges = Array.isArray(judgeNames) ? judgeNames.filter((n) => !judgeKeys.includes(n)) : [];
if (unknownJudges.length > 0) {
  throw new Error(`Unknown judge(s): ${unknownJudges.join(", ")}. Available: ${judgeKeys.join(", ")} (or "all"/"none").`);
}
const judgeEvaluators =
  Array.isArray(judgeNames) && judgeNames.length === 0
    ? []
    : makeJudgeEvaluators({
        names: judgeNames,
        estimatedTokens: JUDGE_TOKENS,
        pace: async (tokens) => {
          await rpmPacer.acquire(1);
          await tpmPacer.acquire(tokens);
        },
      });

const data = await resolveData();
const nExamples = data.length;
const judgeCount = judgeEvaluators.length;
console.log(
  `Evaluating "${DATASET}"${SPLIT ? ` (split: ${SPLIT})` : ""}${LIMIT ? ` (limit: ${LIMIT})` : ""} — ${nExamples} examples\n` +
    `  TPM ${TPM_BUDGET} | RPM ${RPM_BUDGET} | binding ${BINDING_REQS_PER_MIN} req/min | ~${TOKENS_PER_REQUEST} tok/turn | host ${EVE_HOST}\n` +
    `  judges: ${judgeCount ? `${judgeCount} (~${JUDGE_TOKENS} tok/call, shared deployment — paced)` : "none"} | metrics: latency_s ttft_s input/output/cached tokens cost_usd\n` +
    `  agent ${gitSha.slice(0, 12)} | experiment prefix "${EXPERIMENT_PREFIX}"`,
);

// Phase A — execute serially, paced. All rate-limit waiting happens HERE,
// outside any LangSmith span.
console.log(`\nPhase A — executing ${nExamples} examples (paced, serial):`);
for (let i = 0; i < data.length; i++) {
  const e = data[i] as unknown as { inputs: Inputs; metadata?: { sample_id?: string } };
  const id = e.metadata?.sample_id ?? `example ${i + 1}`;
  const rec = await executeAgent(e.inputs);
  records.set(recordKey(e.inputs), rec);
  console.log(
    `  [${i + 1}/${nExamples}] ${id} — ${rec.failed ? "FAILED TURN" : "ok"} | ${((rec.metrics.latency_ms ?? 0) / 1000).toFixed(2)}s | ${rec.metrics.input_tokens ?? "—"} in / ${rec.metrics.output_tokens ?? "—"} out tok`,
  );
}

// Phase B — evaluate the records (judges are the only live model calls here).
console.log(`\nPhase B — scoring with ${judgeCount} judge(s) + deterministic evaluators + metrics:`);
const results = await evaluate(runAgent, {
  data,
  evaluators: [...baselineEvaluators, ...metricEvaluators, ...judgeEvaluators] as never,
  experimentPrefix: EXPERIMENT_PREFIX,
  maxConcurrency: CONCURRENCY,
  metadata: {
    agent_commit: gitSha,
    model_deployment: MODEL_NAME,
    dataset: DATASET,
    dataset_split: SPLIT ?? "all",
    eval_concurrency: CONCURRENCY,
    tpm_budget: TPM_BUDGET,
    rpm_budget: RPM_BUDGET,
  },
});

// Compact console summary: per-evaluator pass rates + per-sample metric rows.
const rows = (results as { results?: unknown[] }).results ?? [];
const byKey = new Map<string, { sum: number; n: number; failures: string[] }>();
for (const row of rows as Array<{
  run?: { outputs?: { sessionId?: string } };
  example?: { metadata?: { sample_id?: string } };
  evaluationResults?: { results?: Array<{ key: string; score?: number | boolean; comment?: string }> };
}>) {
  const sampleId = row.example?.metadata?.sample_id ?? "?";
  for (const r of row.evaluationResults?.results ?? []) {
    const score = typeof r.score === "boolean" ? (r.score ? 1 : 0) : (r.score ?? 0);
    const agg = byKey.get(r.key) ?? { sum: 0, n: 0, failures: [] };
    agg.sum += score;
    agg.n += 1;
    if (score < 1) agg.failures.push(`${sampleId} (${r.comment?.slice(0, 80) ?? ""})`);
    byKey.set(r.key, agg);
  }
}
const METRIC_KEYS = new Set(["latency_s", "ttft_s", "input_tokens", "output_tokens", "cache_read_tokens", "cost_usd"]);
console.log(`\n=== ${EXPERIMENT_PREFIX} summary (${rows.length} examples) ===`);
console.log("  Quality (pass rate):");
for (const [key, { sum, n, failures }] of byKey) {
  if (METRIC_KEYS.has(key)) continue;
  console.log(`    ${key}: ${((sum / Math.max(1, n)) * 100).toFixed(0)}% (${Math.round(sum * 100) / 100}/${n})`);
  for (const f of failures) console.log(`        ✗ ${f}`);
}
// Per-sample performance/cost table (no averages — every sample's own numbers).
interface SampleMetricsRow {
  run?: { outputs?: { metrics?: Record<string, number | null>; failed?: boolean } };
  example?: { metadata?: { sample_id?: string } };
}
console.log("  Performance/cost per sample:");
console.log("    sample | latency_s | ttft_s | in_tok | out_tok | cached | cost_usd");
let totalCost = 0;
let totalIn = 0;
let totalOut = 0;
for (const row of rows as SampleMetricsRow[]) {
  const id = row.example?.metadata?.sample_id ?? "?";
  const m = row.run?.outputs?.metrics ?? {};
  const fmt = (v: number | null | undefined, div = 1, dp = 2) =>
    v == null ? "—" : String(Math.round((v / div) * 10 ** dp) / 10 ** dp);
  totalCost += m.cost_usd ?? 0;
  totalIn += m.input_tokens ?? 0;
  totalOut += m.output_tokens ?? 0;
  console.log(
    `    ${id} | ${fmt(m.latency_ms, 1000)} | ${fmt(m.ttft_ms, 1000)} | ${m.input_tokens ?? "—"} | ${m.output_tokens ?? "—"} | ${m.cache_read_tokens ?? "—"} | ${m.cost_usd == null ? "—" : "$" + (Math.round(m.cost_usd * 10_000) / 10_000)}` +
      (row.run?.outputs?.failed ? "  (turn failed)" : ""),
  );
}
console.log(`    TOTAL | in ${totalIn} tok | out ${totalOut} tok | $${(Math.round(totalCost * 10_000) / 10_000).toFixed(4)}`);
console.log(
  "\nRoot Latency in LangSmith = true response time (measured in Phase A, replayed in Phase B)." +
    "\nNative token/cost columns come from the per-turn llm child runs (usage_metadata + ls_model_name).",
);
