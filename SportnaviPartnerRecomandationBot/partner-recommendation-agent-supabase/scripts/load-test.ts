/**
 * Load & latency driver: sends real partner-search turns through the running
 * dev server (`npm run dev:ui` must already be up on :3000) and records
 * wall-clock results per turn.
 *
 * Run:  npx tsx --env-file=.env.local scripts/load-test.ts
 *
 * Phases:
 *   1. baseline — sequential realistic queries (one session, German + English
 *      mixes, small city / big city / vague intent) to measure single-user
 *      latency per scenario.
 *   2. ramp — N concurrent sessions × 1 query each at increasing N, to find
 *      throughput degradation and the Azure rate-limit ceiling.
 *
 * Results land in .data/loadtest-results.json for the reporting pipeline.
 * Server-side truth (model latency, tokens, tool spans) lives in Sentry.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { Client } from "eve/client";

const HOST = process.env.LOAD_TEST_HOST ?? "http://127.0.0.1:3000";

interface TurnRecord {
  phase: string;
  concurrency: number;
  scenario: string;
  status: string;
  wallMs: number;
  messageChars: number;
  error?: string;
  startedAt: string;
}

const records: TurnRecord[] = [];

/**
 * Per-turn ceiling. MEASURED NEED, not paranoia: on Windows dev the just-bash
 * sandbox backend can hang forever when the agent consults its skill
 * (repeated "opening sandbox session" in the eve log, no further model
 * calls). A hung turn must become a data point ("timeout"), not block the
 * whole test run. See reports/markdown/Bottleneck-Analysis.md.
 */
const TURN_TIMEOUT_MS = Number(process.env.LOAD_TEST_TURN_TIMEOUT_MS ?? 150_000);

async function runTurn(
  phase: string,
  concurrency: number,
  scenario: string,
  session: ReturnType<Client["session"]>,
  text: string,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  try {
    const response = await session.send(text);
    const result = await Promise.race([
      response.result(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("turn timed out")), TURN_TIMEOUT_MS),
      ),
    ]);
    records.push({
      phase,
      concurrency,
      scenario,
      status: result.status,
      wallMs: Math.round(performance.now() - t0),
      messageChars: result.message?.length ?? 0,
      startedAt,
    });
  } catch (error) {
    records.push({
      phase,
      concurrency,
      scenario,
      status: error instanceof Error && error.message === "turn timed out" ? "timeout" : "transport_error",
      wallMs: Math.round(performance.now() - t0),
      messageChars: 0,
      error: error instanceof Error ? error.message : String(error),
      startedAt,
    });
  }
}

const client = new Client({ host: HOST });
const health = await client.health();
console.log(`health: ${health.status}`);

// --- Phase 1: baseline, sequential single user ---------------------------
const BASELINE: Array<[string, string]> = [
  ["big-city", "Ich suche Anfänger-Kletterkurse in Bielefeld."],
  ["small-city", "Yoga für Wiedereinsteiger in Gütersloh, bitte."],
  ["vague-intent", "Ich will wieder fit werden, wohne in Bochum. Was empfiehlst du?"],
  ["follow-up", "Und gibt es davon etwas speziell für Stressabbau?"],
  ["english", "Any good swimming courses in Paderborn?"],
];

// Baseline sessions are independent so one hung turn cannot poison the rest.

console.log("phase 1: baseline (sequential)…");
{
  let session = client.session();
  for (const [scenario, text] of BASELINE) {
    // follow-up continues the previous session; every other scenario starts
    // fresh so a hung or failed turn cannot poison the next measurement.
    if (scenario !== "follow-up") session = client.session();
    await runTurn("baseline", 1, scenario, session, text);
    console.log(`  ${scenario}: ${records.at(-1)?.status} in ${records.at(-1)?.wallMs}ms`);
  }
}

// --- Phase 2: concurrency ramp -------------------------------------------
const RAMP_QUERIES = [
  "Krafttraining in Dortmund für Anfänger?",
  "Pilates in Münster gesucht.",
  "Schwimmkurse für Kinder in Essen?",
  "Ich möchte in Hamm mit Boxen anfangen.",
  "Rückenschule in Osnabrück?",
  "Tanzen lernen in Bielefeld, Standard und Latein.",
];

for (const level of [2, 4, 6]) {
  console.log(`phase 2: ramp at concurrency ${level}…`);
  await Promise.all(
    Array.from({ length: level }, async (_, i) => {
      const session = client.session();
      await runTurn("ramp", level, `query-${i}`, session, RAMP_QUERIES[i % RAMP_QUERIES.length]);
    }),
  );
  const batch = records.filter((r) => r.phase === "ramp" && r.concurrency === level);
  const failed = batch.filter((r) => r.status !== "completed" && r.status !== "waiting").length;
  console.log(
    `  level ${level}: ${batch.length} turns, ${failed} failed, ` +
      `avg ${Math.round(batch.reduce((s, r) => s + r.wallMs, 0) / batch.length)}ms`,
  );
}

mkdirSync(".data", { recursive: true });
writeFileSync(".data/loadtest-results.json", JSON.stringify(records, null, 2));
console.log(`\nwrote ${records.length} turn records to .data/loadtest-results.json`);
