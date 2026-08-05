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
 * Run via `npm run generate:coverage`. Requires MEMORY_SUPABASE_URL and
 * MEMORY_SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.ts) — loaded from
 * .env.local via lib/load-env. Fails loudly (and does nothing to the
 * output file) when those are unset, e.g. in CI without secrets configured.
 */
import "../lib/load-env";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getSupabase } from "../lib/supabase";

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../agent/instructions/002-city-coverage.md",
);

const PAGE_SIZE = 1000;

/** How many of the largest cities to put in the prompt. See the comment in
 *  main() for why this is not the full list. */
const TOP_N = 40;

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

async function fetchActiveCities(): Promise<string[]> {
  const supabase = getSupabase();
  const cities: string[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("partners")
      .select("city")
      .eq("is_active", true)
      .not("city", "is", null)
      .range(from, to);

    if (error) {
      throw new Error(`generate-city-coverage: query failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    for (const row of data as { city: string | null }[]) {
      if (row.city != null) cities.push(row.city);
    }

    if (data.length < PAGE_SIZE) break;
  }

  return cities;
}

async function main() {
  let cities: string[];
  try {
    cities = await fetchActiveCities();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "generate-city-coverage: could not reach Supabase to regenerate " +
        "agent/instructions/002-city-coverage.md.\n" +
        `Cause: ${message}\n` +
        "This script requires MEMORY_SUPABASE_URL and " +
        "MEMORY_SUPABASE_SERVICE_ROLE_KEY (see .env.local.example). " +
        "The output file was NOT modified.",
    );
    process.exitCode = 1;
    return;
  }

  const counts = new Map<string, number>();
  for (const rawCity of cities) {
    const trimmed = rawCity.trim();
    if (trimmed.length === 0) continue;
    const key = initcap(trimmed);
    counts.set(key, (counts.get(key) ?? 0) + 1);
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
