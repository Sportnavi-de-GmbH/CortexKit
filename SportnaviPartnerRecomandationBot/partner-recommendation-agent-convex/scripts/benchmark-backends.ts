/**
 * benchmark-backends.ts — the apples-to-apples Supabase vs Convex measurement.
 *
 *   npm run benchmark                    # both backends, default cases
 *   npm run benchmark -- --only convex   # one backend
 *   npm run benchmark -- --iterations 10 --warmup 2
 *   npm run benchmark -- --cold          # skip warm-up; measures cold latency
 *
 * ── WHAT IS MEASURED, AND WHY IT IS ONLY THE DATA LAYER ──────────────────────
 *
 * This drives the DETERMINISTIC pipeline — resolveCityFuzzy -> resolvePartners
 * -> buildRecommendations — against both backends, with the same cases, the
 * same config, and the same embedding provider. It does NOT call the LLM.
 *
 * That is deliberate, and it is what makes the number trustworthy. A full
 * agent turn is dominated by two Azure model steps costing 7-27 s (CLAUDE.md
 * §4.1); the database work is a fraction of that. Measuring end-to-end would
 * bury the difference you are trying to see under model-latency variance you
 * cannot control, and CLAUDE.md §11 is the standing warning about what happens
 * when you trust an aggregate metric that mixes work you did with work you
 * skipped. The backend is the only variable between these two projects, so the
 * backend is what gets timed.
 *
 * If you also want the end-to-end figure, run the eval harness against each
 * build (`npx tsx evals/run-experiment.ts`) and compare LangSmith latency —
 * see BENCHMARKING.md.
 *
 * ── FAIRNESS CONTROLS ────────────────────────────────────────────────────────
 *
 *  1. IN-PROCESS CACHES ARE CLEARED between every single run. Both builds have
 *     a 1 h search cache, a 24 h city-centroid cache and a per-process
 *     embedding cache. Leaving any of them warm would measure the cache, not
 *     the database — and would flatter whichever backend happened to run
 *     second.
 *  2. EMBEDDINGS ARE PRE-COMPUTED ONCE PER CASE, outside the timer, and
 *     injected into both runs. The embedding provider is a third-party HTTP
 *     call identical in both builds; including it would add ~200-800 ms of
 *     shared noise to every sample.
 *  3. The two stacks ALTERNATE per iteration rather than running in blocks, so
 *     a slow network minute cannot land entirely on one backend.
 *  4. Warm-up runs are discarded (connection setup, JIT, Convex function
 *     cold-start). `--cold` keeps them, which is a different and also
 *     interesting question.
 *  5. Both sides are loaded from their OWN project directory, so each uses its
 *     own lib/, its own config, and its own node_modules.
 *
 * ── REQUIREMENTS ─────────────────────────────────────────────────────────────
 *
 *  - This project seeded and verified (`npm run setup`).
 *  - The Supabase project present at ../partner-recommendation-agent with its
 *    own .env.local and node_modules (override with
 *    BENCHMARK_SUPABASE_PROJECT_DIR).
 *  - EMBEDDING_API_URL / EMBEDDING_API_KEY in this project's .env.local.
 *
 * Results are written to benchmarks/results/<timestamp>.json.
 */
import "../lib/load-env";

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONVEX_DIR = path.resolve(HERE, "..");
const SUPABASE_DIR = path.resolve(
  CONVEX_DIR,
  process.env.BENCHMARK_SUPABASE_PROJECT_DIR ?? "../partner-recommendation-agent",
);
const RESULTS_DIR = path.join(CONVEX_DIR, "benchmarks", "results");

// ─── Cases ───────────────────────────────────────────────────────────────────

interface Case {
  id: string;
  /** City exactly as a user would type it — misspellings included. */
  cityMention: string;
  intentText: string;
  tags: string[];
  /** What this case is meant to stress. */
  why: string;
}

/**
 * Chosen to cover the shapes of the directory that behave differently, not to
 * be a broad sample. The directory is brutally uneven (CLAUDE.md §1) and the
 * gap-fill path — the expensive one — only fires for cities below the
 * minPartners target, which under the active wide-context config is every city
 * except Bielefeld.
 */
const CASES: Case[] = [
  {
    id: "big-city-no-gapfill",
    cityMention: "Bielefeld",
    intentText: "Krafttraining für Wiedereinsteiger",
    tags: ["krafttraining"],
    why: "the ONLY city with 100+ partners — home city alone can satisfy the target, so gap-fill is skipped. Isolates the home-fetch + hydration path.",
  },
  {
    id: "medium-city-gapfill",
    cityMention: "Bochum",
    intentText: "Kletterkurse für Anfänger",
    tags: ["klettern"],
    why: "a well-covered city that still needs gap-fill: home fetch + concurrent fan-out over ~9 nearby cities + 100-profile hydration. The typical request.",
  },
  {
    id: "thin-city-wide-gapfill",
    cityMention: "Ahlen",
    intentText: "sanft wieder einsteigen, Yoga oder Rückenkurs",
    tags: ["yoga"],
    why: "a thin city: almost the entire shortlist is borrowed, so this is the worst-case latency path in the product.",
  },
  {
    id: "misspelled-city",
    // "Dormund" (dropped 't') resolves to Dortmund at trigram similarity 0.545
    // in BOTH builds — verified live. It has to clear resolve_city_fuzzy's 0.4
    // floor, or the case measures a failed lookup instead of a fuzzy one:
    // "Dortmnud" (transposed) scores below the floor and resolves to nothing
    // on either side, which is consistent but useless as a benchmark.
    cityMention: "Dormund",
    intentText: "Boxen für Einsteiger",
    tags: ["boxen"],
    why: "exercises fuzzy city resolution — a trigram scan over ~650 materialized cities in Convex vs pg_trgm over 2,331 rows with no expression index in Postgres.",
  },
  {
    id: "no-tags",
    cityMention: "Essen",
    intentText: "etwas für den Rücken, gerne mit Betreuung",
    tags: [],
    why: "no tags means the tg RRF branch never fires, so ranking leans entirely on vector + FTS.",
  },
];

// ─── Backend adapters ────────────────────────────────────────────────────────

/** The per-run measurement. Wall-clock, plus the resolver's own stage timings. */
interface Sample {
  totalMs: number;
  resolveCityMs: number;
  resolvePartnersMs: number;
  buildRecommendationsMs: number;
  stageTimingsMs: Record<string, number>;
  homeCount: number;
  filledCount: number;
  citiesUsed: number;
  recommendations: number;
  profileChars: number;
  warnings: number;
}

interface Backend {
  name: "supabase" | "convex";
  /** Clears every in-process cache. Called before EVERY run. */
  reset(): Promise<void>;
  /** Embeds once, outside the timer. */
  embed(text: string): Promise<number[]>;
  run(c: Case, embedding: number[]): Promise<Sample>;
}

/**
 * Both projects expose the same module paths with the same exports, so one
 * loader works for both — the only difference is which directory it resolves
 * from. Dynamic import (rather than a static one) is what lets this process
 * hold BOTH implementations at once.
 */
async function loadBackend(name: "supabase" | "convex", dir: string): Promise<Backend> {
  if (!existsSync(dir)) {
    throw new Error(
      `benchmark: ${name} project not found at ${dir}. ` +
        "Set BENCHMARK_SUPABASE_PROJECT_DIR to its path.",
    );
  }
  const mod = (rel: string) => import(pathToFileURL(path.join(dir, rel)).href);

  const [
    { resolveCityFuzzy },
    { resolvePartners },
    { buildRecommendations },
    { invalidateSearchCache },
    { embedText, clearEmbeddingCache },
    client,
  ] = await Promise.all([
    mod("lib/partners/extract-city.ts"),
    mod("lib/partners/resolve-partners.ts"),
    mod("lib/partners/build-recommendations.ts"),
    mod("lib/partners/search-cache.ts"),
    mod("lib/embeddings.ts"),
    name === "convex" ? mod("lib/convex.ts") : mod("lib/supabase.ts"),
  ]);

  const getClient = name === "convex" ? client.getConvex : client.getSupabase;

  return {
    name,
    async reset() {
      // The search cache would make run 2+ of a case a pure memory read.
      invalidateSearchCache();
      // The embedding cache is cleared too, even though embeddings are
      // injected — so a stray un-injected embed cannot be served warm.
      clearEmbeddingCache();
      // NOTE: the 24 h city-centroid cache is a module-level singleton with no
      // exported invalidator in either build. It is warmed identically by the
      // warm-up run on both sides, so it does not favour either backend — but
      // it does mean the gap-fill numbers exclude the centroid fetch. Called
      // out in BENCHMARKING.md.
    },
    embed: (text: string) => embedText(text),
    async run(c, embedding) {
      const t0 = performance.now();

      const city = await resolveCityFuzzy(c.cityMention, getClient());
      const t1 = performance.now();
      if (!city) throw new Error(`${name}: "${c.cityMention}" did not resolve`);

      const set = await resolvePartners(
        { city, intent: { text: c.intentText, tags: c.tags } },
        // Inject the pre-computed embedding so the third-party embedding call
        // is outside the timer on both sides.
        { embedTextFn: async () => embedding },
      );
      const t2 = performance.now();

      const built = await buildRecommendations({ set, finalRecommendations: 100 });
      const t3 = performance.now();

      return {
        totalMs: t3 - t0,
        resolveCityMs: t1 - t0,
        resolvePartnersMs: t2 - t1,
        buildRecommendationsMs: t3 - t2,
        stageTimingsMs: set.meta.timingsMs,
        homeCount: set.home.length,
        filledCount: set.filled.length,
        citiesUsed: set.citiesUsed.length,
        recommendations: built.recommendations.length,
        profileChars: built.recommendations.reduce((n: number, r: any) => n + r.llmProfile.length, 0),
        warnings: built.warnings.length,
      };
    },
  };
}

// ─── Statistics ──────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

function summarize(samples: Sample[]) {
  const totals = samples.map((s) => s.totalMs).sort((a, b) => a - b);
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  return {
    n: totals.length,
    minMs: round(totals[0]!),
    p50Ms: round(percentile(totals, 0.5)),
    p95Ms: round(percentile(totals, 0.95)),
    maxMs: round(totals[totals.length - 1]!),
    meanMs: round(mean),
    stdDevMs: round(
      Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length),
    ),
    stages: {
      resolveCityMs: round(avg(samples.map((s) => s.resolveCityMs))),
      resolvePartnersMs: round(avg(samples.map((s) => s.resolvePartnersMs))),
      buildRecommendationsMs: round(avg(samples.map((s) => s.buildRecommendationsMs))),
    },
    // The work-actually-performed signal. CLAUDE.md §11: a backend that
    // returns fewer partners is FASTER, and that is not a win. If these
    // numbers differ between the two stacks, the latency comparison is void.
    work: {
      homeCount: samples[0]!.homeCount,
      filledCount: samples[0]!.filledCount,
      citiesUsed: samples[0]!.citiesUsed,
      recommendations: samples[0]!.recommendations,
      profileChars: samples[0]!.profileChars,
      warnings: samples[0]!.warnings,
    },
  };
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x: number) => Math.round(x * 10) / 10;

// ─── Main ────────────────────────────────────────────────────────────────────

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

async function main() {
  const iterations = Number.parseInt(
    arg("--iterations", process.env.BENCHMARK_ITERATIONS ?? "5"),
    10,
  );
  const warmup = process.argv.includes("--cold")
    ? 0
    : Number.parseInt(arg("--warmup", process.env.BENCHMARK_WARMUP ?? "1"), 10);
  const only = arg("--only", "both");

  console.log("Backend benchmark — deterministic pipeline only (no LLM)");
  console.log(`  iterations : ${iterations} measured, ${warmup} warm-up (discarded)`);
  console.log(`  cases      : ${CASES.length}`);
  console.log(`  convex     : ${CONVEX_DIR}`);
  console.log(`  supabase   : ${SUPABASE_DIR}\n`);

  const backends: Backend[] = [];
  if (only === "both" || only === "convex") {
    backends.push(await loadBackend("convex", CONVEX_DIR));
  }
  if (only === "both" || only === "supabase") {
    backends.push(await loadBackend("supabase", SUPABASE_DIR));
  }
  if (backends.length === 0) throw new Error(`benchmark: unknown --only value "${only}"`);

  const results: Record<string, Record<string, unknown>> = {};

  for (const c of CASES) {
    console.log(`\n── ${c.id} — "${c.cityMention}" / "${c.intentText}"`);
    console.log(`   ${c.why}`);

    // ONE embedding per case, shared by both backends and every iteration, so
    // the third-party embedding call is entirely outside the measurement and
    // both stacks search with a bit-identical vector.
    const embedding = await backends[0]!.embed(c.intentText);

    const samples: Record<string, Sample[]> = {};
    for (const b of backends) samples[b.name] = [];

    for (let i = 0; i < warmup + iterations; i++) {
      // Alternate backends per iteration so a slow network minute cannot land
      // entirely on one of them.
      for (const b of backends) {
        await b.reset();
        try {
          const sample = await b.run(c, embedding);
          if (i >= warmup) samples[b.name]!.push(sample);
        } catch (err) {
          console.error(
            `   ${b.name} FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      process.stdout.write(`\r   run ${i + 1}/${warmup + iterations}`);
    }
    process.stdout.write("\n");

    results[c.id] = { case: c };
    for (const b of backends) {
      const s = samples[b.name]!;
      if (s.length === 0) {
        console.log(`   ${b.name.padEnd(8)} : no successful runs`);
        continue;
      }
      const summary = summarize(s);
      (results[c.id] as Record<string, unknown>)[b.name] = summary;
      console.log(
        `   ${b.name.padEnd(8)} : p50 ${String(summary.p50Ms).padStart(7)} ms  ` +
          `p95 ${String(summary.p95Ms).padStart(7)} ms  ` +
          `mean ${String(summary.meanMs).padStart(7)} ms  ` +
          `| ${summary.work.recommendations} recs, ${summary.work.homeCount}+${summary.work.filledCount} resolved, ` +
          `${summary.work.profileChars} chars`,
      );
    }

    // Comparability gate. Different work => the latency numbers are not
    // comparable, and saying so loudly beats printing a misleading speedup.
    if (backends.length === 2) {
      const a = (results[c.id] as any).convex?.work;
      const b = (results[c.id] as any).supabase?.work;
      if (a && b) {
        const same =
          a.recommendations === b.recommendations &&
          a.homeCount === b.homeCount &&
          a.filledCount === b.filledCount;
        if (!same) {
          console.log(
            "   ⚠  WORK MISMATCH — the two backends returned different result sets, " +
              "so the latency numbers above are NOT comparable for this case. " +
              "Investigate before quoting a speedup (see BENCHMARKING.md).",
          );
        } else {
          const speedup = (results[c.id] as any).supabase.p50Ms / (results[c.id] as any).convex.p50Ms;
          console.log(
            `   =  identical work; convex is ${speedup.toFixed(2)}x ` +
              `${speedup >= 1 ? "faster" : "slower"} at p50`,
          );
        }
      }
    }
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RESULTS_DIR, `${stamp}.json`);
  await writeFile(
    file,
    JSON.stringify(
      { ranAt: new Date().toISOString(), iterations, warmup, results },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nWrote ${file}`);
}

main().catch((err) => {
  console.error("\nBENCHMARK FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
