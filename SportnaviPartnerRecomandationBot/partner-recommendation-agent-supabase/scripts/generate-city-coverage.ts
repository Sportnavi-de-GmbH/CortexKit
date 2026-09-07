/**
 * generate-city-coverage.ts — deploy-time regeneration of
 * agent/instructions/002-city-coverage.md from the live `partners` table.
 *
 * Equivalent to:
 *   SELECT initcap(trim(city)) || ' (' || count(*) || ')' AS entry, count(*) AS cnt
 *   FROM public.partners
 *   WHERE is_active AND city IS NOT NULL AND trim(city) <> ''
 *   GROUP BY initcap(trim(city))
 *   ORDER BY cnt DESC, entry;
 *
 * SUPABASE: a PAGED scan of `partners.city` for active rows. Paging is not
 * optional — PostgREST silently caps an unbounded select at 1,000 rows, which
 * once hid 314 cities from the prompt for weeks (root CLAUDE.md §10.9). The
 * total is cross-checked against an exact count at the end so a short read
 * fails loudly instead of shipping a truncated list.
 *
 * Run via `npm run generate:coverage`. Requires MEMORY_SUPABASE_URL +
 * MEMORY_SUPABASE_SERVICE_ROLE_KEY — loaded from .env.local via lib/load-env.
 * Fails loudly (and does nothing to the output file) when they are unset.
 *
 * Re-run this after every partner import: the coverage list is baked into
 * the system prompt, and a stale list makes Navio offer cities that no
 * longer exist.
 */
import "../lib/load-env";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../agent/instructions/002-city-coverage.md",
);

/** How many of the largest cities to put in the prompt. See the comment in
 *  main() for why this is not the full list. */
const TOP_N = 40;

const PAGE_SIZE = 500;

/**
 * Postgres `initcap()`: uppercase the first letter of each whitespace-
 * separated word, lowercase the rest. Applied after trimming, matching the
 * SQL this script mirrors.
 */
function initcap(value: string): string {
  return value
    .split(/(\s+)/)
    .map((chunk) => {
      if (/^\s+$/.test(chunk) || chunk.length === 0) return chunk;
      return chunk[0]!.toUpperCase() + chunk.slice(1).toLowerCase();
    })
    .join("");
}

/**
 * One row per distinct trimmed active city spelling, with its partner count.
 * Same shape the Convex reference's `cityCoverage` table yields, so the
 * regrouping in main() is unchanged.
 */
async function fetchActiveCities(): Promise<Array<{ city: string; count: number }>> {
  const url = process.env.MEMORY_SUPABASE_URL;
  const key = process.env.MEMORY_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("MEMORY_SUPABASE_URL / MEMORY_SUPABASE_SERVICE_ROLE_KEY are unset");
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const counts = new Map<string, number>();
  let scanned = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await sb
      .from("partners")
      .select("city")
      .eq("is_active", true)
      .not("city", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`partners query failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as Array<{ city: string | null }>) {
      scanned++;
      const trimmed = (row.city ?? "").trim();
      if (trimmed.length === 0) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    if (data.length < PAGE_SIZE) break;
  }

  const { count: expected, error: countErr } = await sb
    .from("partners")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .not("city", "is", null);
  if (countErr) throw new Error(`count check failed: ${countErr.message}`);
  if (expected !== null && expected !== scanned) {
    throw new Error(
      `paged scan read ${scanned} rows but the table has ${expected} — refusing to write a truncated coverage list`,
    );
  }
  if (counts.size === 0) {
    throw new Error("no active partners with a city — is this the service-role key?");
  }

  return [...counts.entries()].map(([city, count]) => ({ city, count }));
}

async function main() {
  let cities: Array<{ city: string; count: number }>;
  try {
    cities = await fetchActiveCities();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "generate-city-coverage: could not reach Supabase to regenerate " +
        "agent/instructions/002-city-coverage.md.\n" +
        `Cause: ${message}\n` +
        "This script requires MEMORY_SUPABASE_URL + MEMORY_SUPABASE_SERVICE_ROLE_KEY " +
        "(see .env.local.example). The output file was NOT modified.",
    );
    process.exitCode = 1;
    return;
  }

  // Regroup by initcap(trim(city)) so spelling-case variants merge, exactly
  // as the original `group by initcap(trim(city))` did.
  const counts = new Map<string, number>();
  for (const row of cities) {
    const trimmed = row.city.trim();
    if (trimmed.length === 0) continue;
    const key = initcap(trimmed);
    counts.set(key, (counts.get(key) ?? 0) + row.count);
  }

  const entries = [...counts.entries()]
    .map(([city, cnt]) => ({ entry: `${city} (${cnt})`, cnt }))
    .sort((a, b) => {
      if (b.cnt !== a.cnt) return b.cnt - a.cnt;
      return a.entry.localeCompare(b.entry, "en");
    });

  // Only the largest cities go into the prompt. Coverage itself is decided by
  // the database (`resolve_city_fuzzy` inside find_partners), which also
  // handles misspellings — so the full ~650-entry list was 10,400 chars of
  // prompt on EVERY model call for a decision the DB already makes better.
  // What the model still needs is a handful of real, well-covered cities to
  // offer when a request lands somewhere we don't serve. The top 40 are 613
  // chars; the full list was 10,417.
  const top = entries.slice(0, TOP_N);

  const body =
    "## Largest cities we operate in (partner count)\n\n" +
    "This is NOT the full coverage list and must not be used to decide whether\n" +
    "a city is covered — `find_partners` resolves that against the database,\n" +
    "including misspellings. Use these only to offer concrete alternatives when\n" +
    "a request lands somewhere we do not serve.\n\n" +
    top.map((e) => e.entry).join(", ") +
    "\n";

  await writeFile(OUTPUT_PATH, body, { encoding: "utf8" });
  console.log(
    `generate-city-coverage: wrote top ${top.length} of ${entries.length} cities ` +
      `(${body.length} chars) to ${OUTPUT_PATH}`,
  );
}

main();
