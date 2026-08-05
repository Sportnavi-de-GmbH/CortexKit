/**
 * run-experiment.ts — upload the edge-case dataset to LangSmith and run the
 * evaluation experiment against the live agent.
 *
 * Run:
 *   npx tsx evals/run-experiment.ts --upload         (create/refresh the dataset only)
 *   npx tsx evals/run-experiment.ts --ids=EC-01,EC-02
 *   npx tsx evals/run-experiment.ts                  (all 10 — real model + real DB cost)
 *
 * LangSmith is EU-region here (LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com).
 * Tracing is forced on for the duration of the run so the experiment and its
 * per-case traces land in the project; .env.local keeps it off for normal dev.
 */
import "../lib/load-env";

process.env.LANGSMITH_TRACING = "true";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "langsmith";

import { runForLangSmith } from "./run-agent";
import {
  groundingNoFabricatedPartners,
  searchActuallyPerformed,
  noInternalsLeaked,
  contactDetailsVerbatim,
  languageIsGerman,
  noFalseCapabilityClaimed,
  resolvedCityDisclosed,
  intentShiftRespected,
  unsupportedFactRate,
  answerRelevance,
  personalizationNotGeneric,
  clarificationOfferedWithAlternatives,
  injectionResisted,
  compoundQuestionFullyAddressed,
  type EvalRunOutputs,
  type EvalScore,
} from "./evaluators";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.join(__dirname, "dataset.json");
const DATASET_NAME = "Navio Partner — Edge Cases v1";

interface Case {
  id: string;
  category: string;
  difficulty: string;
  turns: string[];
  context: Record<string, unknown>;
  expected: { mustCallTool?: string[]; behavior: string; mustNot: string[] };
  primaryMetric: string;
  metrics: string[];
  knownDefect?: string;
}

const data = JSON.parse(fs.readFileSync(DATASET_PATH, "utf8")) as {
  meta: Record<string, unknown>;
  cases: Case[];
};

/** Runs every metric a case declares. Order: cheap deterministic first. */
async function scoreCase(c: Case, out: EvalRunOutputs): Promise<EvalScore[]> {
  const question = c.turns[c.turns.length - 1]!;
  const wanted = new Set(c.metrics);
  const scores: EvalScore[] = [];

  if (wanted.has("search_actually_performed")) scores.push(searchActuallyPerformed(out, c.expected));
  if (wanted.has("no_internals_leaked")) scores.push(noInternalsLeaked(out));
  if (wanted.has("contact_details_verbatim")) scores.push(contactDetailsVerbatim(out));
  if (wanted.has("language_is_german")) scores.push(languageIsGerman(out));
  if (wanted.has("no_false_capability_claimed")) scores.push(noFalseCapabilityClaimed(out));
  if (wanted.has("resolved_city_disclosed")) scores.push(resolvedCityDisclosed(out));
  if (wanted.has("intent_shift_respected")) scores.push(intentShiftRespected(out));

  if (wanted.has("grounding_no_fabricated_partners")) {
    scores.push(await groundingNoFabricatedPartners(out, c.turns));
  }
  if (wanted.has("unsupported_fact_rate")) scores.push(await unsupportedFactRate(out));
  if (wanted.has("answer_relevance")) scores.push(await answerRelevance(out, question));
  if (wanted.has("personalization_not_generic")) {
    scores.push(await personalizationNotGeneric(out, question));
  }
  if (wanted.has("clarification_offered_with_alternatives")) {
    scores.push(await clarificationOfferedWithAlternatives(out));
  }
  if (wanted.has("injection_resisted")) scores.push(await injectionResisted(out, question));
  if (wanted.has("compound_question_fully_addressed")) {
    scores.push(await compoundQuestionFullyAddressed(out, question));
  }

  return scores;
}

async function upsertDataset(client: Client): Promise<string> {
  let datasetId: string | undefined;
  for await (const d of client.listDatasets({ datasetName: DATASET_NAME })) {
    datasetId = d.id;
    break;
  }

  if (datasetId) {
    console.log(`Dataset "${DATASET_NAME}" exists (${datasetId}) — replacing examples.`);
    for await (const ex of client.listExamples({ datasetId })) {
      await client.deleteExample(ex.id);
    }
  } else {
    const created = await client.createDataset(DATASET_NAME, {
      description:
        "10 hardest edge cases for the Navio partner agent. Every case is grounded in a verified " +
        "live-database fact (2,331 partners / 648 cities, 2026-08-01). Targets the failure modes " +
        "this codebase has actually exhibited: CLAUDE.md §11 fabrication, rule #10 hours/price " +
        "invention, silent city ambiguity, cross-intent cache contamination, internals leakage.",
    });
    datasetId = created.id;
    console.log(`Created dataset "${DATASET_NAME}" (${datasetId}).`);
  }

  await client.createExamples(
    data.cases.map((c) => ({
      dataset_id: datasetId as string,
      inputs: { turns: c.turns, question: c.turns[c.turns.length - 1] },
      outputs: {
        expectedBehavior: c.expected.behavior,
        mustCallTool: c.expected.mustCallTool ?? [],
        mustNot: c.expected.mustNot,
        primaryMetric: c.primaryMetric,
      },
      metadata: {
        caseId: c.id,
        category: c.category,
        difficulty: c.difficulty,
        metrics: c.metrics,
        groundTruth: c.context.groundTruth,
        whyHard: c.context.whyHard,
        ...(c.knownDefect ? { knownDefect: c.knownDefect } : {}),
      },
    })),
  );
  console.log(`Uploaded ${data.cases.length} examples.\n`);
  return datasetId as string;
}

async function main() {
  const argv = process.argv.slice(2);
  const uploadOnly = argv.includes("--upload");
  const idsArg = argv.find((a) => a.startsWith("--ids="));
  const ids = idsArg ? idsArg.split("=")[1]!.split(",") : null;

  const client = new Client();
  const datasetId = await upsertDataset(client);
  if (uploadOnly) {
    console.log("Upload complete (--upload). Skipping the experiment run.");
    return;
  }

  const cases = ids ? data.cases.filter((c) => ids.includes(c.id)) : data.cases;
  const experimentName = `navio-edge-cases-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`Running ${cases.length} case(s) as experiment "${experimentName}"…\n`);

  const rows: Array<{
    case: Case;
    scores: EvalScore[];
    answer: string;
    toolsCalled: string[];
    error?: string;
  }> = [];

  /** Courtesy gap between cases — see the pacing note in run-agent.ts. */
  const CASE_DELAY_MS = 8000;

  for (const [i, c] of cases.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, CASE_DELAY_MS));
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} ${c.category} … `);
    try {
      const out = (await runForLangSmith({ turns: c.turns })) as unknown as EvalRunOutputs;
      const scores = await scoreCase(c, out);
      rows.push({ case: c, scores, answer: out.finalAnswer, toolsCalled: out.toolsCalled });

      const primary = scores.find((s) => s.key === c.primaryMetric);
      const failed = scores.filter((s) => s.score === 0);
      console.log(
        `${primary?.score === 1 ? "PASS" : "FAIL"} (primary ${c.primaryMetric})` +
          (failed.length ? ` — ${failed.length} metric(s) failing` : ""),
      );

      // Log to LangSmith as a run against the dataset example.
      const example = await (async () => {
        for await (const ex of client.listExamples({ datasetId })) {
          if ((ex.metadata as { caseId?: string } | undefined)?.caseId === c.id) return ex;
        }
        return undefined;
      })();

      if (example) {
        const run = await client.createRun({
          name: `navio ${c.id}`,
          run_type: "chain",
          inputs: { turns: c.turns },
          outputs: { finalAnswer: out.finalAnswer, toolsCalled: out.toolsCalled },
          reference_example_id: example.id,
          project_name: experimentName,
          start_time: Date.now(),
          end_time: Date.now(),
        });
        const runId = (run as unknown as { id?: string })?.id;
        if (runId) {
          for (const s of scores) {
            await client.createFeedback(runId, s.key, {
              score: s.score,
              comment: s.comment,
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR — ${msg}`);
      rows.push({ case: c, scores: [], answer: "", toolsCalled: [], error: msg });
    }
  }

  // ── local report ─────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${experimentName}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ experimentName, ranAt: new Date().toISOString(), rows }, null, 2),
  );

  console.log(`\n${"═".repeat(78)}\nRESULTS\n${"═".repeat(78)}`);
  const byMetric = new Map<string, { pass: number; total: number }>();
  let primaryPass = 0;

  // An infrastructure error is NOT a quality signal. Counting a 429 as an agent
  // failure understates the agent and, worse, hides it inside the same number —
  // you would not be able to tell a rate limit from a fabrication.
  const errored = rows.filter((r) => r.error);
  const scored = rows.filter((r) => !r.error);

  for (const r of scored) {
    const primary = r.scores.find((s) => s.key === r.case.primaryMetric);
    if (primary?.score === 1) primaryPass++;
    for (const s of r.scores) {
      const agg = byMetric.get(s.key) ?? { pass: 0, total: 0 };
      agg.total++;
      if (s.score === 1) agg.pass++;
      byMetric.set(s.key, agg);
    }
  }

  console.log(`\nPrimary metric: ${primaryPass}/${scored.length} scored cases pass`);
  if (errored.length > 0) {
    console.log(
      `${errored.length} case(s) NOT SCORED (infrastructure, not quality): ${errored
        .map((r) => r.case.id)
        .join(", ")}`,
    );
  }
  console.log();
  console.log("Per-metric:");
  for (const [k, v] of [...byMetric.entries()].sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total)) {
    console.log(`  ${v.pass === v.total ? "  " : "!!"} ${k.padEnd(42)} ${v.pass}/${v.total}`);
  }

  console.log("\nFailures:");
  let any = false;
  for (const r of rows) {
    const failed = r.scores.filter((s) => s.score === 0);
    if (!failed.length && !r.error) continue;
    any = true;
    console.log(`\n  ${r.case.id} (${r.case.category})${r.case.knownDefect ? "  [known defect]" : ""}`);
    if (r.error) console.log(`    ERROR: ${r.error}`);
    for (const s of failed) console.log(`    ✗ ${s.key}: ${s.comment}`);
  }
  if (!any) console.log("  (none)");

  console.log(`\nWritten to ${outPath}`);
  console.log(`LangSmith project: ${experimentName}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
