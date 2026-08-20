/**
 * sync-shared-env.ts — keep the two builds on the SAME credentials.
 *
 *   npm run sync:env          # apply
 *   npm run sync:env -- --check   # report drift, exit 1 if any (no writes)
 *
 * WHY THIS EXISTS
 *
 * The whole premise of this project is "the backend is the only variable".
 * That premise dies quietly the moment the two `.env.local` files drift: point
 * one build at a different Azure deployment and you are no longer comparing
 * Supabase against Convex, you are comparing two different models — and
 * nothing in the benchmark output would tell you. It happened once already:
 * the Azure deployment was changed in the Supabase build, the Convex build
 * kept the old one, and its agent turns failed on a rate-limited deployment
 * while the Supabase build was fine.
 *
 * So the Supabase build's `.env.local` is the SINGLE SOURCE OF TRUTH for every
 * shared credential, and this script copies them across.
 *
 * WHAT IS DELIBERATELY *NOT* SYNCED
 *
 *  - `LANGSMITH_PROJECT` — must differ, or the two builds' traces land in one
 *    project and become impossible to tell apart.
 *  - `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` — each Navio agent build
 *    carries its own Langfuse project's key pair (CLAUDE.md §16); syncing them
 *    from the sibling would silently merge two trace streams into one project.
 *  - `CONVEX_*` / `NEXT_PUBLIC_CONVEX_*` — Convex-only; written by
 *    `npx convex dev` and never present in the Supabase build.
 *
 * Values are never printed. Drift is reported as a short hash so you can see
 * THAT something differs without the secret appearing in a terminal, a CI log,
 * or a screenshot.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONVEX_ENV = path.resolve(HERE, "../.env.local");
const SUPABASE_ENV = path.resolve(
  HERE,
  "..",
  process.env.BENCHMARK_SUPABASE_PROJECT_DIR ?? "../partner-recommendation-agent",
  ".env.local",
);

/** Shared with the Supabase build; MUST be identical in both. */
const SHARED = [
  "AZURE_AI_CHATBOT_OPENAI_ENDPOINT",
  "AZURE_AI_CHATBOT_API_KEY",
  "AZURE_AI_CHATBOT_DEPLOYMENT_NAME",
  "EMBEDDING_API_URL",
  "EMBEDDING_API_KEY",
  "MEMORY_SUPABASE_URL",
  "MEMORY_SUPABASE_SERVICE_ROLE_KEY",
  "LANGSMITH_API_KEY",
  "LANGSMITH_ENDPOINT",
  "LANGSMITH_TRACING",
  "LANGSMITH_RECORD_IO",
  "SENTRY_DSN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ENVIRONMENT",
  "SENTRY_RECORD_IO",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_TRACING_ENVIRONMENT",
  "LANGFUSE_RECORD_IO",
  "PARTNER_PROXY_SECRET",
] as const;

/** Must NOT be copied — see the header. */
const NEVER_SYNC = new Set(["LANGSMITH_PROJECT", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);

const fingerprint = (v: string) =>
  v === "" ? "(empty)" : createHash("sha256").update(v).digest("hex").slice(0, 8);

function parseEnv(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return out;
}

/** Rewrites `KEY=` lines in place, preserving comments, order and everything
 *  else in the file. Appends keys that are missing. */
function applyUpdates(file: string, updates: Map<string, string>): void {
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  const applied = new Set<string>();

  const next = lines.map((line) => {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return line;
    const eq = t.indexOf("=");
    if (eq === -1) return line;
    const key = t.slice(0, eq).trim();
    if (!updates.has(key)) return line;
    applied.add(key);
    return `${key}=${updates.get(key)}`;
  });

  const missing = [...updates].filter(([k]) => !applied.has(k));
  if (missing.length > 0) {
    next.push("", "# --- added by scripts/sync-shared-env.ts ---");
    for (const [k, v] of missing) next.push(`${k}=${v}`);
  }
  writeFileSync(file, next.join("\n"), "utf-8");
}

function main() {
  const checkOnly = process.argv.includes("--check");

  if (!existsSync(SUPABASE_ENV)) {
    throw new Error(
      `sync-shared-env: no .env.local at ${SUPABASE_ENV}. ` +
        "Set BENCHMARK_SUPABASE_PROJECT_DIR if the Supabase build lives elsewhere.",
    );
  }
  if (!existsSync(CONVEX_ENV)) {
    throw new Error(
      `sync-shared-env: no .env.local at ${CONVEX_ENV}. ` +
        "Run `npx convex dev` once, then copy .env.local.example into it.",
    );
  }

  const source = parseEnv(SUPABASE_ENV);
  const target = parseEnv(CONVEX_ENV);

  const updates = new Map<string, string>();
  const rows: string[] = [];

  for (const key of SHARED) {
    if (NEVER_SYNC.has(key)) continue;
    const from = source.get(key);
    if (from === undefined) continue; // not set in the source; nothing to copy
    const to = target.get(key);
    if (to === from) {
      rows.push(`  ok    ${key.padEnd(36)} ${fingerprint(from)}`);
      continue;
    }
    updates.set(key, from);
    rows.push(
      `  DRIFT ${key.padEnd(36)} ${to === undefined ? "(missing)" : fingerprint(to)} -> ${fingerprint(from)}`,
    );
  }

  console.log(`source: ${SUPABASE_ENV}`);
  console.log(`target: ${CONVEX_ENV}\n`);
  console.log(rows.join("\n"));

  const proj = { s: source.get("LANGSMITH_PROJECT"), c: target.get("LANGSMITH_PROJECT") };
  console.log(
    `\n  skip  LANGSMITH_PROJECT${" ".repeat(20)}` +
      `${proj.s ?? "(unset)"} vs ${proj.c ?? "(unset)"} — must differ, not synced`,
  );

  if (updates.size === 0) {
    console.log("\nNo drift. Both builds share the same credentials.");
    return;
  }

  if (checkOnly) {
    console.log(
      `\n${updates.size} variable(s) have drifted. Run \`npm run sync:env\` to fix.\n` +
        "Until then, any benchmark comparing the two builds is invalid.",
    );
    process.exitCode = 1;
    return;
  }

  applyUpdates(CONVEX_ENV, updates);
  console.log(
    `\nSynced ${updates.size} variable(s) into the Convex build.\n` +
      "Restart `npm run dev:ui` for it to take effect.",
  );
}

try {
  main();
} catch (err) {
  console.error("SYNC FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
