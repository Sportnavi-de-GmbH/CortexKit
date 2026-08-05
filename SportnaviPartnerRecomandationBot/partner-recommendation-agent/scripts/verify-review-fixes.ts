/**
 * verify-review-fixes.ts — live verification of the defects fixed on 2026-08-01.
 * Run: npx tsx scripts/verify-review-fixes.ts
 *
 * Each of these failed SILENTLY: a successful query that returned less than it
 * was asked for, or a filter key that was simply never sent. None of them
 * surfaced in `app.tools_used`, `app.model_steps`, or the resolution events —
 * which is exactly why they need an assertion that runs against live services.
 *
 *   C1  get_partner_profiles carried a hardcoded `limit 10`, so a 100-id
 *       request hydrated 10 profiles. The other 90 reached the model as a name
 *       and city with an EMPTY body (nearby partners have no body_markdown
 *       fallback) — the CLAUDE.md §11 fabrication setup.
 *   C2  getCityCentroids() selected every active partner through PostgREST,
 *       which capped the response at 1,000 rows — hiding 314 of 648 cities
 *       from gap-fill and averaging survivors' centroids over partial data.
 *   H2  filters.tags was never passed to match_partners, so `tag_overlap` was
 *       NULL on every row: one of four RRF branches dead, and requireTagMatch
 *       would have discarded 100% of candidates.
 *
 * Exits 1 if any assertion fails.
 */
import "../lib/load-env";

import { getSupabase } from "../lib/supabase";
import { resolveCityFuzzy } from "../lib/partners/extract-city";
import { resolvePartners } from "../lib/partners/resolve-partners";
import { buildRecommendations } from "../lib/partners/build-recommendations";
import { findNearbyCities } from "../lib/partners/find-nearby-cities";

let failed = false;
const check = (name: string, pass: boolean, detail: string) => {
  if (!pass) failed = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function main() {
  const sb = getSupabase();

  const home = await resolveCityFuzzy("Bochum", sb);
  if (!home) throw new Error("Bochum did not resolve — cannot run verification");

  // ── C2 — the neighbour map must cover the whole directory ────────────────
  const neighbours = await findNearbyCities(
    { home, limit: 10_000, maxDistanceKm: null },
    { supabase: sb },
  );
  const { count: cityCount } = await sb
    .from("partners")
    .select("city", { count: "exact", head: true })
    .eq("is_active", true);
  check(
    "C2 centroid map",
    neighbours.length > 600,
    `${neighbours.length + 1} cities reachable (was 334 of 648; ${cityCount} active partners)`,
  );

  // ── C1 — every rendered partner must carry real profile text ─────────────
  const set = await resolvePartners({
    city: home,
    intent: { text: "Krafttraining für Wiedereinsteiger", tags: ["krafttraining"] },
  });
  const built = await buildRecommendations({ set, finalRecommendations: 100 });
  const empty = built.recommendations.filter((r) => r.llmProfile.trim().length === 0);
  const chars = built.recommendations.reduce((n, r) => n + r.llmProfile.length, 0);

  check(
    "C1 profile hydration",
    empty.length === 0 && built.recommendations.length > 10,
    `${built.recommendations.length} rendered, ${empty.length} empty ` +
      `(resolved home=${set.home.length} filled=${set.filled.length})`,
  );
  console.log(`      payload    : ${chars} chars (~${Math.round(chars / 4)} tokens)`);
  console.log(`      disclosure : ${built.disclosure}`);
  if (built.warnings.length > 0) {
    console.log(`      warnings   : ${JSON.stringify(built.warnings)}`);
  }

  // ── H2 — filters.tags must reach the RPC and populate tag_overlap ────────
  const { data, error } = await sb.rpc("match_partners", {
    query_embedding: null,
    query_text: "Yoga",
    filters: { city: "Dortmund", tags: ["yoga"] },
    match_count: 20,
  });
  if (error) throw new Error(`match_partners failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ tag_overlap: number | null }>;
  const withOverlap = rows.filter((r) => (r.tag_overlap ?? 0) > 0).length;
  check(
    "H2 tag ranking branch",
    withOverlap > 0,
    `${withOverlap}/${rows.length} rows carry tag_overlap > 0 (was 0 — the tg CTE never fired)`,
  );

  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
