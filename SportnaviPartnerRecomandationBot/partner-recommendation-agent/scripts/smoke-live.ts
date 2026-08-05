/**
 * smoke-live.ts — live credential + pipeline smoke test.
 * Run: npx tsx scripts/smoke-live.ts
 *
 * Stages (each reports PASS/FAIL and continues where possible):
 *   1. Supabase  — count active partners
 *   2. Embedding — embed a test string, expect 1536 dims
 *   3. Azure LLM — extract_city on a real German request
 *   4. Pipeline  — resolvePartners + buildRecommendations for
 *                  "Krafttraining rund um die Uhr in Aalen"
 * Never prints secrets. Exits 1 if any stage fails.
 */
import "../lib/load-env";

import { getSupabase } from "../lib/supabase";
import { embedText, EMBEDDING_DIMENSIONS } from "../lib/embeddings";
import { extractCityAndIntent } from "../lib/partners/extract-city";
import { resolvePartners } from "../lib/partners/resolve-partners";
import { buildRecommendations } from "../lib/partners/build-recommendations";
import { renderTier1, renderTier2 } from "../lib/partners/render-context";

let failed = false;
const ok = (stage: string, detail: string) => console.log(`PASS  ${stage} — ${detail}`);
const bad = (stage: string, err: unknown) => {
  failed = true;
  console.error(`FAIL  ${stage} — ${err instanceof Error ? err.message : String(err)}`);
};

async function main() {
  // 1. Supabase
  try {
    const { count, error } = await getSupabase()
      .from("partners")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);
    if (error) throw new Error(error.message);
    ok("supabase", `${count} active partners`);
  } catch (e) {
    bad("supabase", e);
  }

  // 2. Embedding
  try {
    const vec = await embedText("Krafttraining rund um die Uhr");
    if (vec.length !== EMBEDDING_DIMENSIONS) throw new Error(`got ${vec.length} dims`);
    ok("embedding", `${vec.length} dims`);
  } catch (e) {
    bad("embedding", e);
  }

  // 3. Azure LLM extraction
  const request = "Krafttraining rund um die Uhr in Aalen";
  let extracted: Awaited<ReturnType<typeof extractCityAndIntent>> | undefined;
  try {
    extracted = await extractCityAndIntent({ requestText: request });
    if (!extracted.city) throw new Error("no city extracted");
    ok(
      "azure-llm",
      `city=${extracted.city.canonical} (confidence ${extracted.city.confidence.toFixed(2)}), intent="${extracted.intent.text}" tags=[${extracted.intent.tags.join(",")}]`,
    );
  } catch (e) {
    bad("azure-llm", e);
  }

  // 4. Full pipeline
  try {
    if (!extracted?.city) throw new Error("skipped — extraction failed");
    const set = await resolvePartners({ city: extracted.city, intent: extracted.intent });
    const summary = `home=${set.home.length} filled=${set.filled.length} cities=[${set.citiesUsed.join(", ")}] minMet=${set.meta.minMet} warnings=${set.meta.warnings.length}`;
    ok("resolve-partners", summary);
    const recs = await buildRecommendations({ set, finalRecommendations: 5 });
    ok(
      "build-recommendations",
      `${recs.recommendations.length} recs — disclosure: "${recs.disclosure}"`,
    );
    console.log("\n--- Tier-1 (first 600 chars) ---");
    console.log(renderTier1(set).slice(0, 600));
    const tier2 = renderTier2(recs.recommendations, {
      requestedCity: set.requestedCity.canonical,
      includeContactInShortlist: recs.includeContactInShortlist,
    });
    console.log(`\n--- Tier-2 (first 800 of ${tier2.length} chars) ---`);
    console.log(tier2.slice(0, 800));
  } catch (e) {
    bad("pipeline", e);
  }

  if (failed) process.exitCode = 1;
}

main();
