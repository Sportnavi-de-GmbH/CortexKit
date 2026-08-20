/**
 * check-dep-parity.ts — assert the two builds run the SAME dependency tree.
 *
 *   npm run check:deps        # exits 1 if any shared dependency differs
 *
 * WHY THIS EXISTS
 *
 * "The backend is the only variable" is the premise of this whole project, and
 * a floating dependency breaks it silently. It has already happened twice over
 * from one root cause — `package-lock.json` was deleted during scaffolding and
 * a fresh `npm install` resolved the caret ranges upward:
 *
 *   eve            0.25.2 -> 0.25.3   the app stopped booting entirely
 *                                     ("Cannot determine intended module
 *                                      format…" from eve's env-runner)
 *   next           15.5.20 -> 15.5.23
 *   ai             7.0.31  -> 7.0.62
 *   @ai-sdk/openai 4.0.16  -> 4.0.40   different agent runtime, silently
 *
 * The crash was loud. The other three were not: the benchmark would have run
 * happily and compared two different agent runtimes while reporting a
 * backend speedup.
 *
 * `convex` is expected to exist ONLY here, and `@supabase/supabase-js` is
 * expected to be a devDependency here (used solely by the one-time export) —
 * both are asserted rather than ignored.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONVEX_ROOT = path.resolve(HERE, "..");
const SUPABASE_ROOT = path.resolve(
  CONVEX_ROOT,
  process.env.BENCHMARK_SUPABASE_PROJECT_DIR ?? "../partner-recommendation-agent",
);

/** Everything that can change how the agent loop behaves. */
const SHARED = [
  "eve",
  "next",
  "ai",
  "@ai-sdk/openai",
  "react",
  "react-dom",
  "zod",
  "@sentry/node",
  "langsmith",
  "@opentelemetry/api",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/sdk-trace-base",
];

function version(root: string, pkg: string): string | null {
  const file = path.join(root, "node_modules", pkg, "package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8")).version as string;
}

function main() {
  if (!existsSync(SUPABASE_ROOT)) {
    throw new Error(
      `check-dep-parity: Supabase build not found at ${SUPABASE_ROOT}. ` +
        "Set BENCHMARK_SUPABASE_PROJECT_DIR if it lives elsewhere.",
    );
  }

  let drift = 0;
  console.log(`${"PACKAGE".padEnd(44)} ${"supabase".padEnd(12)} convex`);

  for (const pkg of SHARED) {
    const s = version(SUPABASE_ROOT, pkg);
    const c = version(CONVEX_ROOT, pkg);
    const ok = s !== null && s === c;
    if (!ok) drift++;
    console.log(
      `${(ok ? "  ok   " : "  DIFF ") + pkg.padEnd(37)} ${(s ?? "-").padEnd(12)} ${c ?? "-"}`,
    );
  }

  // Expected asymmetries — asserted, not assumed.
  const convexPkg = version(CONVEX_ROOT, "convex");
  console.log(`\n  convex (this build only)                   ${convexPkg ?? "MISSING"}`);
  if (convexPkg === null) {
    drift++;
    console.log("  ^ convex is not installed — `npm install`");
  }

  const pkgJson = JSON.parse(readFileSync(path.join(CONVEX_ROOT, "package.json"), "utf-8"));
  if (pkgJson.dependencies?.eve !== "0.25.2") {
    drift++;
    console.log(
      `\n  DRIFT eve must stay EXACTLY pinned in package.json (found ` +
        `"${pkgJson.dependencies?.eve}"). 0.25.3 does not boot — see SETUP.md §1.`,
    );
  }
  if (pkgJson.dependencies?.["@supabase/supabase-js"]) {
    drift++;
    console.log(
      "\n  DRIFT @supabase/supabase-js is in `dependencies`; it belongs in " +
        "`devDependencies` — the agent runtime must not depend on Supabase.",
    );
  }

  if (drift > 0) {
    console.log(
      `\n${drift} parity problem(s). Any benchmark run now is comparing more than ` +
        "the backend.\nFix:\n" +
        "  cp ../partner-recommendation-agent/package-lock.json . && npm install",
    );
    process.exitCode = 1;
  } else {
    console.log("\nDependency trees match. Only the data layer differs.");
  }
}

try {
  main();
} catch (err) {
  console.error("CHECK FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
