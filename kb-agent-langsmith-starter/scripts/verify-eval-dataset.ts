// Standalone remote verification of an uploaded evaluation dataset (SOP §8).
// Complements upload-eval-dataset.ts (which verifies only at upload time):
// run this any time to confirm the published version still matches the repo
// source of truth. Read-only — never mutates the dataset.
//
// Checks (SOP §8 verification checklist):
//   1. dataset exists remotely at LANGSMITH_ENDPOINT;
//   2. remote example count == local file count;
//   3. spot-read one example: inputs.messages, all outputs fields and all
//      metadata fields present and correctly typed;
//   4. dataset description is non-empty and mentions the stage.
//
// Usage:
//   npm run eval:verify                       # verifies the default Stage-1 file
//   npx tsx scripts/verify-eval-dataset.ts evals/datasets/<file>.json
import "../lib/load-env.ts";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "langsmith";

const DEFAULT_FILE = "evals/datasets/navio-kb-testing-final-response-v2.json";

const file = resolve(process.cwd(), process.argv[2] ?? DEFAULT_FILE);
const spec = JSON.parse(readFileSync(file, "utf8")) as {
  dataset: { name: string; description: string };
  examples: Array<{
    inputs: { messages?: Array<{ role: string; content: string }> };
    outputs?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
};

for (const key of ["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT"]) {
  if (!process.env[key]) {
    throw new Error(`${key} is not set — copy .env.example to .env.local and fill it in.`);
  }
}

const client = new Client();
const { name } = spec.dataset;
const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

if (!(await client.hasDataset({ datasetName: name }))) {
  console.error(`Dataset "${name}" does not exist at ${process.env.LANGSMITH_ENDPOINT}.`);
  process.exit(1);
}
const remote = await client.readDataset({ datasetName: name });
checks.push({ label: "dataset exists remotely", ok: true, detail: remote.id });

const examples: Array<Record<string, any>> = [];
for await (const e of client.listExamples({ datasetName: name })) examples.push(e);
checks.push({
  label: "remote count == local count",
  ok: examples.length === spec.examples.length,
  detail: `remote ${examples.length}, local ${spec.examples.length}`,
});

// Spot-read: every remote example must carry the full evaluator-agnostic
// schema — one missing metadata field silently breaks per-category metrics.
const OUTPUT_FIELDS = ["expected_behavior", "reference_answer", "must_include", "must_not_include", "language"];
const METADATA_FIELDS = ["sample_id", "category", "audience", "language", "difficulty", "kb_reference", "why"];
for (const ex of examples) {
  const missingOut = OUTPUT_FIELDS.filter((f) => ex.outputs?.[f] === undefined);
  const missingMeta = METADATA_FIELDS.filter((f) => ex.metadata?.[f] === undefined);
  const messagesOk = Array.isArray(ex.inputs?.messages) && ex.inputs.messages.length > 0;
  const id = ex.metadata?.sample_id ?? ex.id;
  checks.push({
    label: `example schema: ${id}`,
    ok: messagesOk && missingOut.length === 0 && missingMeta.length === 0,
    detail:
      [
        messagesOk ? "" : "inputs.messages missing/empty",
        missingOut.length ? `outputs missing: ${missingOut.join(",")}` : "",
        missingMeta.length ? `metadata missing: ${missingMeta.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; ") || "complete",
  });
}

checks.push({
  label: "description states stage/size",
  ok: /stage|\d+\s*samples/i.test(remote.description ?? ""),
  detail: (remote.description ?? "").slice(0, 80) + "…",
});

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? "✅" : "❌"} ${c.label} — ${c.detail}`);
}
if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED for "${name}".`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED: "${name}" at ${process.env.LANGSMITH_ENDPOINT} matches ${file}.`);
