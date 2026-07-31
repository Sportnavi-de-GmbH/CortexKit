// Shared dataset-upload logic: used by scripts/upload-eval-dataset.ts (manual
// upload) and scripts/run-eval.ts (self-healing pre-flight). Datasets in this
// workspace have repeatedly VANISHED from LangSmith EU within ~an hour of
// upload (see Langsmith/LANGSMITH-DATASET-GUIDE.md troubleshooting, 2026-07-27)
// — the repo JSON is the source of truth, so restoring is always safe and
// automatic restoration keeps eval runs unblocked.
import { readFileSync } from "node:fs";

import { Client } from "langsmith";

export interface DatasetSpec {
  dataset: { name: string; description: string; metadata?: Record<string, unknown> };
  examples: Array<{
    split?: string;
    inputs: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
}

export function readDatasetSpec(file: string): DatasetSpec {
  return JSON.parse(readFileSync(file, "utf8")) as DatasetSpec;
}

async function countExamples(client: Client, name: string): Promise<number> {
  let n = 0;
  for await (const _ of client.listExamples({ datasetName: name })) n++;
  return n;
}

/**
 * Creates the dataset (if missing) and bulk-inserts all examples in ONE
 * createExamples call. Refuses to touch a dataset that already has examples
 * (version immutability). Returns the verified remote count.
 */
export async function uploadDataset(client: Client, spec: DatasetSpec): Promise<number> {
  const { name, description, metadata } = spec.dataset;

  if (await client.hasDataset({ datasetName: name })) {
    const existing = await countExamples(client, name);
    if (existing > 0) {
      throw new Error(
        `Dataset "${name}" already exists with ${existing} examples. Uploaded versions are ` +
          `immutable — bump the vN suffix for changes, or delete the dataset in LangSmith first.`,
      );
    }
  } else {
    await client.createDataset(name, { description, metadata });
  }

  await client.createExamples(
    spec.examples.map((e) => ({
      dataset_name: name,
      inputs: e.inputs,
      outputs: e.outputs,
      metadata: e.metadata,
      split: e.split,
    })),
  );

  const remote = await countExamples(client, name);
  if (remote !== spec.examples.length) {
    throw new Error(`Upload verification FAILED: remote has ${remote} examples, expected ${spec.examples.length}.`);
  }
  return remote;
}

/**
 * Self-healing pre-flight: ensure the dataset exists remotely with examples;
 * restore it from the repo spec file when it has vanished. Returns "existing"
 * or "restored".
 */
export async function ensureDataset(client: Client, specFile: string): Promise<"existing" | "restored"> {
  const spec = readDatasetSpec(specFile);
  const name = spec.dataset.name;
  if ((await client.hasDataset({ datasetName: name })) && (await countExamples(client, name)) > 0) {
    return "existing";
  }
  await uploadDataset(client, spec);
  return "restored";
}
