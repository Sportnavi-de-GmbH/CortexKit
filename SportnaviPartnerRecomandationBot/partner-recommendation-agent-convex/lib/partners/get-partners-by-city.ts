/**
 * lib/partners/get-partners-by-city.ts
 *
 * Return ALL active partners of the home city — no ranking, no trimming.
 * This is the golden rule in code: the home city is taken whole. Any
 * trimming happens ONLY in the overflow case, inside the (later) orchestrator.
 *
 * CONVEX PORT of the Supabase build's file of the same name. The Supabase
 * version issued TWO PostgREST requests: a `partners` select filtered by
 * `.in("city", aliases)`, then a manual `partner_intelligence` join (no FK
 * exists between the two tables, so PostgREST embedding was unavailable).
 * Both now happen inside ONE Convex query — see convex/partners.ts — which is
 * the single biggest structural difference on this path and one of the things
 * the benchmark is measuring.
 *
 * Everything downstream is unchanged: the same columns, the same dedupe-by-id,
 * the same best-effort treatment of quality_score, the same `PartnerRow` shape.
 * No email/phone: contact info reaches the model only inside `llm_profile`.
 */

import { getConvex, type ConvexBackend } from "../convex";
import type { PartnerRow } from "./types";

export interface GetPartnersByCityInput {
  aliases: string[]; // all matching city spellings from resolve_city_fuzzy
  tagFilter?: string[]; // optional; overlap filter applied ONLY when provided & non-empty
  includeInactive?: boolean;
}

/**
 * Fetches every partner whose `city` matches any of `aliases`, with
 * `quality_score` joined best-effort, deduped by id.
 *
 * Deduplication happens server-side now (aliases can overlap), but the
 * client-side pass is kept below because it is cheap and it keeps this
 * function's contract identical to the Supabase build's for the unit suite.
 */
export async function getPartnersByCity(
  input: GetPartnersByCityInput,
  convex: ConvexBackend = getConvex(),
  opts?: { signal?: AbortSignal },
): Promise<PartnerRow[]> {
  if (input.aliases.length === 0) return []; // no coverage (E2)

  const rows = await convex.getPartnersByCity(
    {
      aliases: input.aliases,
      ...(input.tagFilter && input.tagFilter.length > 0 ? { tagFilter: input.tagFilter } : {}),
      ...(input.includeInactive !== undefined ? { includeInactive: input.includeInactive } : {}),
    },
    { signal: opts?.signal },
  );

  const byId = new Map<number, PartnerRow>();
  for (const r of rows) {
    if (byId.has(r.id)) continue;
    byId.set(r.id, {
      id: r.id,
      name: r.name,
      city: r.city,
      tags_norm: r.tags_norm,
      body_markdown: r.body_markdown,
      website_url: r.website_url,
      is_active: r.is_active,
      updated_at: r.updated_at,
      quality_score: r.quality_score,
    });
  }
  return [...byId.values()];
}
