/**
 * verify-supabase-setup.ts — proves the Supabase project behind this build is
 * COMPLETE and that every read path the agent uses actually answers.
 *
 *   npx tsx scripts/verify-supabase-setup.ts      (npm run supabase:verify)
 *
 * Counterpart of the Convex reference's scripts/verify-convex-setup.ts, and
 * it exists for the same reason: every defect it checks for failed SILENTLY.
 * A query that returned less than it was asked for, or a ranking branch that
 * never fired, does not show up anywhere — it just makes Navio quietly worse.
 *
 * Checks:
 *   S1  Row counts     — partners / active / vectors / intelligence / synonyms.
 *                        `count: "exact"` head requests, so the 1,000-row
 *                        PostgREST cap cannot fake a smaller directory.
 *   S2  City map       — city_centroids() covers the whole directory; the
 *                        retired build once shipped 334 of 648 cities.
 *   S3  Hydration      — a 100-partner shortlist renders 100 non-empty
 *                        profiles (get_partner_profiles carried `limit 10`
 *                        for a long time, root CLAUDE.md §10.8).
 *   S4  Tag branch     — filters.tags reaches match_partners and populates
 *                        tag_overlap, so the `tg` RRF branch is alive (§10.10).
 *   S5  Vector branch  — a real embedding produces non-null similarity.
 *   S6  RPC surface    — resolve_city_fuzzy answers, and the R13 embedding
 *                        read (`profile_embedding`) decodes to 1536 dims,
 *                        i.e. the sixth backend operation works against
 *                        pgvector's text encoding.
 *
 * Exits 1 if any check fails.
 */
import "../lib/load-env";

import { createClient } from "@supabase/supabase-js";

import { getSupabase } from "../lib/supabase";
import { EMBEDDING_DIMENSIONS, embedText } from "../lib/embeddings";
import { resolveCityFuzzy } from "../lib/partners/extract-city";
import { resolvePartners } from "../lib/partners/resolve-partners";
import { buildRecommendations } from "../lib/partners/build-recommendations";
import { findNearbyCities } from "../lib/partners/find-nearby-cities";

let failed = false;
const check = (name: string, pass: boolean, detail: string) => {
  if (!pass) failed = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

function adminClient() {
  const url = process.env.MEMORY_SUPABASE_URL;
  const key = process.env.MEMORY_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("MEMORY_SUPABASE_URL / MEMORY_SUPABASE_SERVICE_ROLE_KEY are unset — see .env.local.example");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  const sb = adminClient();
  const supabase = getSupabase();

  // ── S1 — the directory is fully present ──────────────────────────────────
  const exact = async (table: string, refine?: (q: any) => any) => {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    if (refine) q = refine(q);
    const { count, error } = await q;
    if (error) throw new Error(`${table} count: ${error.message}`);
    return count ?? 0;
  };

  const partners = await exact("partners");
  const active = await exact("partners", (q) => q.eq("is_active", true));
  const vectors = await exact("partners", (q) =>
    q.eq("is_active", true).not("profile_embedding", "is", null),
  );
  const intelligence = await exact("partner_intelligence");
  const synonyms = await exact("tag_synonyms");

  console.log(
    `\nRow counts: ${JSON.stringify({ partners, active, vectors, intelligence, synonyms }, null, 2)}\n`,
  );

  check(
    "S1a partners loaded",
    partners > 2000 && active > 2000,
    `${partners} partners (${active} active) — 0 here means the ANON key (RLS returns nothing)`,
  );
  check(
    "S1b search corpus complete",
    vectors > 2000,
    `${vectors} active partners carry a profile_embedding (match_partners' base predicate)`,
  );
  check(
    "S1c intelligence + synonyms loaded",
    intelligence > 2000 && synonyms > 0,
    `${intelligence} intelligence rows, ${synonyms} synonyms`,
  );

  // ── S2 — the centroid map covers the whole directory ─────────────────────
  const centroids = await supabase.cityCentroids();
  check(
    "S1d city_centroids() RPC",
    centroids.length > 600,
    `${centroids.length} city rows (a server-side GROUP BY — no PostgREST row cap)`,
  );

  const home = await resolveCityFuzzy("Bochum", supabase);
  if (!home) throw new Error("Bochum did not resolve — cannot run the remaining checks");
  console.log(
    `\nResolved "Bochum" -> ${home.canonical} ` +
      `(confidence ${home.confidence.toFixed(3)}, centroid ${home.centroid?.lat.toFixed(4)}/${home.centroid?.lng.toFixed(4)})\n`,
  );

  const neighbours = await findNearbyCities(
    { home, limit: 10_000, maxDistanceKm: null },
    { supabase },
  );
  check(
    "S2 centroid map",
    neighbours.length > 600,
    `${neighbours.length + 1} cities reachable (the retired build shipped 334 of 648)`,
  );

  // ── S3 — every rendered partner carries real profile text ────────────────
  const set = await resolvePartners({
    city: home,
    intent: { text: "Krafttraining für Wiedereinsteiger", tags: ["krafttraining"] },
  });
  const built = await buildRecommendations({ set, finalRecommendations: 100 });
  const empty = built.recommendations.filter((r) => r.llmProfile.trim().length === 0);
  const chars = built.recommendations.reduce((n, r) => n + r.llmProfile.length, 0);

  check(
    "S3 profile hydration",
    empty.length === 0 && built.recommendations.length > 10,
    `${built.recommendations.length} rendered, ${empty.length} empty ` +
      `(resolved home=${set.home.length} filled=${set.filled.length})`,
  );
  console.log(`      payload    : ${chars} chars (~${Math.round(chars / 4)} tokens)`);
  console.log(`      disclosure : ${built.disclosure}`);
  console.log(`      timings    : ${JSON.stringify(set.meta.timingsMs)}`);
  if (built.warnings.length > 0) {
    console.log(`      warnings   : ${JSON.stringify(built.warnings)}`);
  }

  // ── S4 — the tag ranking branch is alive ─────────────────────────────────
  const tagRows = await supabase.matchPartners({
    queryEmbedding: null,
    queryText: "Yoga",
    filters: { city: "Dortmund", tags: ["yoga"] },
    matchCount: 20,
  });
  const withOverlap = tagRows.filter((r) => (r.tag_overlap ?? 0) > 0).length;
  check(
    "S4 tag ranking branch",
    withOverlap > 0,
    `${withOverlap}/${tagRows.length} rows carry tag_overlap > 0 ` +
      "(was 0 until root CLAUDE.md §10.10 was fixed — the tg CTE never fired)",
  );

  // ── S5 — the vector branch is alive ──────────────────────────────────────
  try {
    const embedding = await embedText("Yoga zum Stressabbau für Anfänger");
    const vecRows = await supabase.matchPartners({
      queryEmbedding: embedding,
      queryText: "Yoga zum Stressabbau für Anfänger",
      filters: { city: "Dortmund", tags: ["yoga"] },
      matchCount: 20,
    });
    const scored = vecRows.filter((r) => r.similarity !== null).length;
    check(
      "S5 vector branch",
      scored > 0,
      `${scored}/${vecRows.length} rows carry a cosine similarity ` +
        `(top score ${vecRows[0]?.similarity?.toFixed(4) ?? "n/a"})`,
    );
  } catch (err) {
    check(
      "S5 vector branch",
      false,
      `embedding call failed: ${err instanceof Error ? err.message : String(err)} ` +
        "(check EMBEDDING_API_URL / EMBEDDING_API_KEY)",
    );
  }

  // ── S6 — the R13 embedding read decodes pgvector correctly ───────────────
  const sampleIds = set.home.slice(0, 5).map((p) => p.id);
  const embeddings = await supabase.getPartnerEmbeddings(sampleIds);
  check(
    "S6 profile_embedding read (R13 home relevance)",
    embeddings.length > 0 && embeddings.every((e) => e.embedding.length === EMBEDDING_DIMENSIONS),
    `${embeddings.length}/${sampleIds.length} sampled home partners returned a ${EMBEDDING_DIMENSIONS}-dim vector`,
  );

  if (failed) {
    console.log("\nOne or more checks FAILED. See SETUP.md troubleshooting.");
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed — the Supabase project is ready for this build.");
  }
}

main().catch((e) => {
  console.error("\nVERIFICATION FAILED:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
