// Uploads a versioned evaluation dataset file (evals/datasets/*.json) to
// LangSmith in ONE batch createExamples call. Refuses to touch a dataset that
// already has examples: uploaded versions are immutable by convention — edit
// the JSON, bump the vN suffix in its `dataset.name` (and filename), and
// upload the new version instead. Shared logic: lib/eval/dataset-upload.ts.
//
// Usage:
//   npm run eval:upload                     # uploads the default (30-sample) file
//   npx tsx scripts/upload-eval-dataset.ts evals/datasets/<file>.json
import "../lib/load-env.ts";

import { resolve } from "node:path";
import { Client } from "langsmith";

import { readDatasetSpec, uploadDataset } from "../lib/eval/dataset-upload.ts";

const DEFAULT_FILE = "evals/datasets/navio-kb-testing-final-response-v2.json";

const file = resolve(process.cwd(), process.argv[2] ?? DEFAULT_FILE);

for (const key of ["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT"]) {
  if (!process.env[key]) {
    throw new Error(`${key} is not set — copy .env.example to .env.local and fill it in.`);
  }
}

const spec = readDatasetSpec(file);
const remote = await uploadDataset(new Client(), spec);
console.log(
  `Uploaded + verified: ${remote}/${spec.examples.length} examples in "${spec.dataset.name}" ` +
    `at ${process.env.LANGSMITH_ENDPOINT} (from ${file}).`,
);
