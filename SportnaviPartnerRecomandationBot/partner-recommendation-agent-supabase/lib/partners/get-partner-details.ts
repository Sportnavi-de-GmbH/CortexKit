/**
 * lib/partners/get-partner-details.ts
 *
 * Direct lookup of ONE partner's full profile by id — for follow-up
 * questions ("tell me more about X"). This is NOT a search: no city
 * resolution, no similarity, no gap-fill. One indexed row fetch via
 * `partners:getPartnerProfiles`, returning the pre-rendered `llm_profile`
 * block.
 *
 * CONVEX PORT of the Supabase build's file of the same name; the Postgres
 * `get_partner_profiles(p_ids)` RPC became convex/partners.ts:getPartnerProfiles
 * with the identical column list and the identical `and p.is_active` predicate,
 * so an inactive id is still an honest not-found rather than a stale profile.
 */

import { getSupabase, type SupabaseBackend } from "../supabase";
import type { PartnerDetails } from "./types";

export interface GetPartnerDetailsInput {
  partnerId: number;
}

export async function getPartnerDetails(
  input: GetPartnerDetailsInput,
  supabase: SupabaseBackend = getSupabase(),
  signal?: AbortSignal,
): Promise<PartnerDetails | null> {
  let rows;
  try {
    rows = await supabase.getPartnerProfiles([input.partnerId], { signal });
  } catch (err) {
    throw new Error(
      `getPartnerDetails: partners:getPartnerProfiles failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const row = rows[0];
  if (!row) return null; // unknown id or inactive partner (honest-unknown)

  return {
    partnerId: row.partner_id,
    name: row.title,
    city: row.city,
    llmProfile: row.llm_profile ?? "",
  };
}
