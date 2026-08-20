/**
 * seed-convex.ts — STEP 2 of the data migration.
 *
 *   npx tsx scripts/seed-convex.ts            # idempotent upsert
 *   npx tsx scripts/seed-convex.ts --reset    # wipe the deployment first
 *
 * Loads `data/export/` (produced by scripts/export-from-supabase.ts) into the
 * Convex deployment named by CONVEX_URL, then rebuilds the materialized city
 * aggregates and records a migration row.
 *
 * IDEMPOTENT: every write is an upsert keyed on the natural key (`sourceId`,
 * `partnerId`, or the slug pair), so re-running converges instead of
 * duplicating. `--reset` exists for the case where rows were REMOVED upstream
 * — an upsert cannot delete what is no longer in the export.
 *
 * ENV REQUIRED:
 *   CONVEX_URL   (or NEXT_PUBLIC_CONVEX_URL) — written by `npx convex dev`
 *
 * No Supabase credentials are needed here. That is the point of the two-step
 * split: the export directory is a portable artifact.
 */
import "../lib/load-env";

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  adminRefs,
  getAdminConvex,
  type EmbeddingSeedRow,
  type IntelligenceSeedRow,
  type PartnerSeedRow,
} from "../lib/convex-admin";

const EXPORT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/export",
);

/**
 * Batch sizes. A Convex mutation has a per-transaction write budget, so these
 * are sized by PAYLOAD, not by row count:
 *  - a partner row carries `llm_profile` (avg 1.6 KB, max 20 KB)
 *  - an embedding row is 1536 float64s (~12 KB serialized)
 */
const PARTNER_BATCH = 40;
const EMBEDDING_BATCH = 25;
const INTELLIGENCE_BATCH = 200;
const TAG_BATCH = 200;

async function* readJsonl<T>(file: string): AsyncGenerator<T> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    yield JSON.parse(line) as T;
  }
}

/** Buffers an async iterable into fixed-size batches. */
async function* batched<T>(source: AsyncGenerator<T>, size: number): AsyncGenerator<T[]> {
  let buffer: T[] = [];
  for await (const item of source) {
    buffer.push(item);
    if (buffer.length >= size) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function requireExport(): Promise<{
  exportedAt: string;
  counts: Record<string, number>;
}> {
  try {
    await stat(path.join(EXPORT_DIR, "manifest.json"));
  } catch {
    throw new Error(
      `no export found at ${EXPORT_DIR}. Run \`npm run convex:export\` first ` +
        "(it needs the Supabase service-role key) — see SETUP.md.",
    );
  }
  return JSON.parse(await readFile(path.join(EXPORT_DIR, "manifest.json"), "utf-8"));
}

async function main() {
  const reset = process.argv.includes("--reset");
  const manifest = await requireExport();
  const convex = getAdminConvex();

  console.log(`Seeding Convex from ${EXPORT_DIR}`);
  console.log(`Export taken ${manifest.exportedAt}: ${JSON.stringify(manifest.counts)}\n`);

  if (reset) {
    process.stdout.write("Clearing deployment... ");
    const { deleted } = await convex.action(adminRefs.clearAll, { confirm: "DELETE-ALL" });
    console.log(`${deleted} documents deleted.`);
  }

  // ── 1. partners (+ the derived partnerSearchDocs rows) ────────────────────
  let partners = 0;
  let searchDocs = 0;
  for await (const rows of batched(
    readJsonl<PartnerSeedRow>(path.join(EXPORT_DIR, "partners.jsonl")),
    PARTNER_BATCH,
  )) {
    const result = await convex.mutation(adminRefs.upsertPartnersBatch, { rows });
    partners += result.inserted + result.updated;
    searchDocs += result.searchDocs;
    process.stdout.write(`\r  partners: ${partners} (search docs: ${searchDocs})`);
  }
  process.stdout.write("\n");

  // ── 2. embeddings (the vector index) ──────────────────────────────────────
  let embeddings = 0;
  for await (const rows of batched(
    readJsonl<EmbeddingSeedRow>(path.join(EXPORT_DIR, "embeddings.jsonl")),
    EMBEDDING_BATCH,
  )) {
    const result = await convex.mutation(adminRefs.upsertEmbeddingsBatch, { rows });
    embeddings += result.written;
    process.stdout.write(`\r  embeddings: ${embeddings}`);
  }
  process.stdout.write("\n");

  // ── 3. partner_intelligence ───────────────────────────────────────────────
  let intelligence = 0;
  for await (const rows of batched(
    readJsonl<IntelligenceSeedRow>(path.join(EXPORT_DIR, "intelligence.jsonl")),
    INTELLIGENCE_BATCH,
  )) {
    const result = await convex.mutation(adminRefs.upsertIntelligenceBatch, { rows });
    intelligence += result.written;
    process.stdout.write(`\r  intelligence: ${intelligence}`);
  }
  process.stdout.write("\n");

  // ── 4. tag synonyms + variants ────────────────────────────────────────────
  const tags = JSON.parse(await readFile(path.join(EXPORT_DIR, "tags.json"), "utf-8")) as {
    synonyms: Array<{ variantSlug: string; canonicalSlug: string }>;
    variants: Array<{ variantLower: string; tagSlug: string }>;
  };
  for (let i = 0; i < Math.max(tags.synonyms.length, tags.variants.length); i += TAG_BATCH) {
    await convex.mutation(adminRefs.upsertTagsBatch, {
      synonyms: tags.synonyms.slice(i, i + TAG_BATCH),
      variants: tags.variants.slice(i, i + TAG_BATCH),
    });
  }
  console.log(`  tags: ${tags.synonyms.length} synonyms, ${tags.variants.length} variants`);

  // ── 5. materialize the SQL GROUP BY aggregates ────────────────────────────
  // MUST run after the partner load: citySpellings backs resolveCityFuzzy and
  // cityCentroids backs the whole gap-fill path. A seeded deployment with
  // stale (or missing) aggregates resolves no cities at all.
  process.stdout.write("  rebuilding city aggregates... ");
  const agg = await convex.action(adminRefs.rebuildCityAggregates, {});
  console.log(
    `${agg.spellings} spellings, ${agg.centroids} centroids, ` +
      `${agg.coverage} coverage rows (from ${agg.partnersScanned} partners)`,
  );

  await convex.mutation(adminRefs.recordMigration, {
    name: "seed-from-supabase-export",
    detail: JSON.stringify({
      exportedAt: manifest.exportedAt,
      loaded: { partners, searchDocs, embeddings, intelligence, ...agg },
      reset,
    }),
  });

  console.log("\nSeed complete. Next: npm run convex:verify");
}

main().catch((err) => {
  console.error("\nSEED FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
