/**
 * verify-convex-setup.ts — STEP 3 of the data migration. Proves the deployment
 * is COMPLETE and behaviourally equivalent to the Supabase build.
 *
 *   npx tsx scripts/verify-convex-setup.ts
 *
 * This is the Convex counterpart of the Supabase build's
 * scripts/verify-review-fixes.ts, and it exists for the same reason: every
 * defect it checks for failed SILENTLY. A successful query that returned less
 * than it was asked for, or a ranking branch that never fired, does not show
 * up in `app.tools_used`, `app.model_steps` or the resolution events — it just
 * makes Navio quietly worse (CLAUDE.md §9, §10.8-10.10, §11).
 *
 * Checks:
 *   S1  Row counts     — every table populated; searchDocs/embeddings agree
 *                        with the active-partner count. Catches a half-seeded
 *                        deployment, the failure mode most likely to be
 *                        mistaken for "this city is thin".
 *   S2  City map       — the centroid table covers the whole directory. The
 *                        Supabase build shipped 334 of 648 cities for weeks.
 *   S3  Hydration      — a 100-partner shortlist renders 100 non-empty
 *                        profiles. The `limit 10` bug (§10.8) rebuilt the
 *                        §11 fabrication setup from the data side.
 *   S4  Tag branch     — filters.tags reaches matchPartners and populates
 *                        tag_overlap, so the `tg` RRF branch is alive (§10.10).
 *   S5  Vector branch  — a real embedding produces non-null similarity, i.e.
 *                        the vector index is populated and being queried.
 *   S6  German FTS     — the ported Snowball stemmer produces the lexemes
 *                        Postgres' `german` dictionary produces. If this
 *                        drifts, the kw branch silently diverges between the
 *                        two builds and the comparison stops being fair.
 *
 * Exits 1 if any check fails.
 */
import "../lib/load-env";

import { adminRefs, getAdminConvex } from "../lib/convex-admin";
import { getConvex } from "../lib/convex";
import { germanLexemes, websearchToTsQuery } from "../convex/lib/germanFts";
import { trigramSimilarity } from "../convex/lib/trigram";
import { slugifyTag } from "../convex/lib/slugify";
import { resolveCityFuzzy } from "../lib/partners/extract-city";
import { resolvePartners } from "../lib/partners/resolve-partners";
import { buildRecommendations } from "../lib/partners/build-recommendations";
import { findNearbyCities } from "../lib/partners/find-nearby-cities";
import { embedText } from "../lib/embeddings";

let failed = false;
const check = (name: string, pass: boolean, detail: string) => {
  if (!pass) failed = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function main() {
  const admin = getAdminConvex();
  const convex = getConvex();

  // ── S1 — the deployment is fully seeded ──────────────────────────────────
  const { counts, migrations } = await admin.action(adminRefs.verifySetup, {});
  console.log(`\nRow counts: ${JSON.stringify(counts, null, 2)}\n`);

  check(
    "S1a partners loaded",
    counts.partners > 2000 && counts.activePartners > 2000,
    `${counts.partners} partners (${counts.activePartners} active)`,
  );
  check(
    "S1b search corpus complete",
    counts.partnerSearchDocs === counts.partnerEmbeddings &&
      counts.partnerSearchDocs > 2000,
    `${counts.partnerSearchDocs} search docs vs ${counts.partnerEmbeddings} vectors ` +
      "(both encode `is_active AND profile_embedding IS NOT NULL`, so they must match)",
  );
  check(
    "S1c intelligence + synonyms loaded",
    counts.partnerIntelligence > 2000 && counts.tagSynonyms > 0,
    `${counts.partnerIntelligence} intelligence, ${counts.tagSynonyms} synonyms`,
  );
  // tagVariants is NOT asserted non-empty, and that is a measured decision
  // rather than a lowered bar. okf.tag_variants only supplies the left side of
  // `coalesce(vm.slug, slugify_tag(x))` in the qraw CTE, and every one of its
  // 706 rows maps a variant to exactly the slug slugify_tag() already
  // produces, with no variant fanning out to several slugs (both verified
  // live -- see the comment in scripts/export-from-supabase.ts:exportTags).
  // The join is therefore a no-op, and most Supabase projects do not expose
  // the `okf` schema through PostgREST at all.
  console.log(
    `INFO  S1c tag variants  -- ${counts.tagVariants} loaded ` +
      (counts.tagVariants === 0
        ? "(none; provably a no-op for qraw -- see export-from-supabase.ts)"
        : "(the okf schema is exposed; variants included)"),
  );
  check(
    "S1d aggregates rebuilt",
    counts.citySpellings > 600 && counts.cityCentroids > 600 && counts.cityCoverage > 600,
    `${counts.citySpellings} spellings, ${counts.cityCentroids} centroids, ` +
      `${counts.cityCoverage} coverage rows`,
  );
  check(
    "S1e migration recorded",
    migrations.length > 0,
    migrations.map((m) => m.name).join(", ") || "none — did seed-convex.ts run?",
  );

  // ── S6 — the German FTS port matches Postgres' `german` dictionary ───────
  // These expectations come from CLAUDE.md §10.4, which documents the exact
  // lexemes `to_tsvector('german', 'yoga entspannung anfänger')` produces.
  const lex = germanLexemes("Yoga Entspannung Anfänger");
  check(
    "S6a german stemmer",
    lex.includes("yoga") && lex.includes("entspann") && lex.includes("anfang"),
    `to_tsvector('german','Yoga Entspannung Anfänger') -> [${lex.join(", ")}] ` +
      "(expected yoga, entspann, anfang)",
  );
  const q = websearchToTsQuery("yoga entspannung anfänger");
  check(
    "S6b websearch AND semantics",
    q !== null && q.and.length === 3,
    `${q?.and.length ?? 0} ANDed groups — websearch_to_tsquery ANDs bare terms, ` +
      "which is why multi-word German intents rarely hit the kw branch (§10.4)",
  );
  check(
    "S6c slugify + trigram",
    slugifyTag("Köln") === "koeln" && trigramSimilarity("bochum", "bochum") === 1,
    `slugify_tag('Köln')='${slugifyTag("Köln")}', similarity('bochum','bochum')=` +
      `${trigramSimilarity("bochum", "bochum")}`,
  );

  // ── S2 — the centroid map covers the whole directory ─────────────────────
  const home = await resolveCityFuzzy("Bochum", convex);
  if (!home) throw new Error("Bochum did not resolve — cannot run the remaining checks");
  console.log(
    `\nResolved "Bochum" -> ${home.canonical} ` +
      `(confidence ${home.confidence.toFixed(3)}, centroid ${home.centroid?.lat.toFixed(4)}/${home.centroid?.lng.toFixed(4)})\n`,
  );

  const neighbours = await findNearbyCities(
    { home, limit: 10_000, maxDistanceKm: null },
    { convex },
  );
  check(
    "S2 centroid map",
    neighbours.length > 600,
    `${neighbours.length + 1} cities reachable (the Supabase build shipped 334 of 648)`,
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
  const tagRows = await convex.matchPartners({
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
      "(was 0 in the Supabase build until §10.10 was fixed — the tg CTE never fired)",
  );

  // ── S5 — the vector branch is alive ──────────────────────────────────────
  try {
    const embedding = await embedText("Yoga zum Stressabbau für Anfänger");
    const vecRows = await convex.matchPartners({
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

  if (failed) {
    console.log("\nOne or more checks FAILED. See SETUP.md troubleshooting.");
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed — the Convex deployment is ready to benchmark.");
  }
}

main().catch((e) => {
  console.error("\nVERIFICATION FAILED:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
