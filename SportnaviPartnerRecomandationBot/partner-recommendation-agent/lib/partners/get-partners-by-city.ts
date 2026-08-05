/**
 * lib/partners/get-partners-by-city.ts
 *
 * Return ALL active partners of the home city — no ranking, no trimming.
 * This is the golden rule in code: the home city is taken whole. Any
 * trimming happens ONLY in the overflow case, inside the (later) orchestrator.
 *
 * Ported from eve-agent-plan/agent/tools/get-partners-by-city.ts (design
 * reference, read-only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import type { PartnerRow } from "./types";

export interface GetPartnersByCityInput {
  aliases: string[]; // all matching city spellings from resolve_city_fuzzy
  tagFilter?: string[]; // optional; overlap filter applied ONLY when provided & non-empty
  includeInactive?: boolean;
}

// No email/phone: contact info must never reach a model-visible tool output
// via this path — it enters context only inside llm_profile, via
// get-partner-details.ts (build_recommendations / owner policy).
// `updated_at` is not PII; included so overflow_trim's "recency" strategy
// (lib/partners/resolve-partners.ts) can sort without a second query.
// Only what is actually read downstream. `postal_code`, `latitude`,
// `longitude` and `courses_text` were selected here for every partner in the
// city (up to 100 rows, and `courses_text` is a large text column) and read by
// nothing — find-nearby-cities.ts runs its own separate coordinates query, and
// the other two never appear outside the type definition. Verified by grep
// across lib/ and agent/ before removal.
const SELECT_COLUMNS =
  "id, name, city, tags_norm, body_markdown, website_url, is_active, updated_at";

/**
 * Fetches every partner whose `city` matches any of `aliases`, joins
 * `partner_intelligence.quality_score` best-effort (no FK constraint exists
 * between the two tables, so PostgREST embedding isn't available — verified
 * live; joined manually in a second query instead), and dedupes by id.
 */
export async function getPartnersByCity(
  input: GetPartnersByCityInput,
  supabase: SupabaseClient = getSupabase(),
  opts?: { signal?: AbortSignal },
): Promise<PartnerRow[]> {
  if (input.aliases.length === 0) return []; // no coverage (E2)

  let query = supabase.from("partners").select(SELECT_COLUMNS).in("city", input.aliases);

  if (!input.includeInactive) {
    query = query.eq("is_active", true);
  }
  if (input.tagFilter && input.tagFilter.length > 0) {
    query = query.overlaps("tags_norm", input.tagFilter);
  }
  if (opts?.signal) {
    query = query.abortSignal(opts.signal);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`getPartnersByCity: partners query failed: ${error.message}`);
  }

  const rows = (data ?? []) as PartnerRow[];

  // Dedup by id: aliases can overlap, or a partner can match twice.
  const byId = new Map<number, PartnerRow>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  const deduped = [...byId.values()];
  if (deduped.length === 0) return deduped;

  const ids = deduped.map((r) => r.id);
  let intelQuery = supabase.from("partner_intelligence").select("partner_id, quality_score").in("partner_id", ids);
  if (opts?.signal) {
    intelQuery = intelQuery.abortSignal(opts.signal);
  }
  const { data: intel, error: intelError } = await intelQuery;
  if (intelError) {
    // Best-effort join: quality_score is a nice-to-have, never block the fetch on it.
    return deduped;
  }

  const qualityById = new Map<number, number | null>(
    ((intel ?? []) as Array<{ partner_id: number; quality_score: number | null }>).map((r) => [
      r.partner_id,
      r.quality_score,
    ]),
  );
  for (const r of deduped) {
    r.quality_score = qualityById.get(r.id) ?? null;
  }
  return deduped;
}
