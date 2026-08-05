/**
 * lib/partners/get-partner-details.ts
 *
 * Direct lookup of ONE partner's full profile by id — for follow-up
 * questions ("tell me more about X"). This is NOT a search: no city
 * resolution, no similarity, no gap-fill. One indexed row fetch via the
 * `get_partner_profiles` RPC, returning the pre-rendered `llm_profile`
 * block.
 *
 * Ported from eve-agent-plan/agent/tools/get-partner-details.ts (design
 * reference, read-only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import type { PartnerDetails } from "./types";

export interface GetPartnerDetailsInput {
  partnerId: number;
}

interface GetPartnerProfilesRow {
  partner_id: number;
  title: string;
  city: string | null;
  llm_profile: string | null;
}

export async function getPartnerDetails(
  input: GetPartnerDetailsInput,
  supabase: SupabaseClient = getSupabase(),
  signal?: AbortSignal,
): Promise<PartnerDetails | null> {
  let query = supabase.rpc("get_partner_profiles", {
    p_ids: [input.partnerId],
  });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) {
    throw new Error(`getPartnerDetails: get_partner_profiles RPC failed: ${error.message}`);
  }

  const rows = (data ?? []) as GetPartnerProfilesRow[];
  const row = rows[0];
  if (!row) return null; // unknown id or inactive partner (honest-unknown)

  return {
    partnerId: row.partner_id,
    name: row.title,
    city: row.city,
    llmProfile: row.llm_profile ?? "",
  };
}
