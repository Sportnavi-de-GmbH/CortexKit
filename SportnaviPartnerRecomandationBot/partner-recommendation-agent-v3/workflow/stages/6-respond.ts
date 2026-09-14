/**
 * Stage 6 — Hydrate the kept partners' profiles (one batched call) and let
 * the model phrase the answer from those profiles ONLY. A missing profile
 * drops that partner (the cut was fixed in stage 5, so UI and answer agree);
 * survivors are renumbered 1..N; no partner beyond the stage-5 cut is added.
 */
import { timeoutSignal } from "../../lib/reused/timeout";
import { buildAnswerPrompt, type AnswerPartner } from "./answer-prompt";
import type { SupabasePartnerProfileRow } from "../../lib/reused/supabase";
import type { RankedRow, Recommendation, RecommendationCard, RespondOutput, StageContext, StageResult } from "../types";

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const httpUrl = (v: unknown): string | null => {
  const s = text(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

/** Everything the widget card shows, from the row already in hand. Pure. */
export function cardFromProfile(p: SupabasePartnerProfileRow): RecommendationCard {
  const pd = (p.profile_data && typeof p.profile_data === "object" ? p.profile_data : {}) as Record<string, unknown>;
  const courses = (text(pd.courses) ?? "").split("|").map((c) => c.trim()).filter(Boolean);
  return {
    logoUrl: httpUrl(p.logo_url),
    street: text(p.street),
    postalCode: text(p.postal_code),
    email: text(p.email),
    phone: text(p.phone),
    websiteUrl: httpUrl(p.website_url),
    mapsUrl: httpUrl(pd.google_maps),
    tags: (p.tags ?? []).map((t) => t.trim()).filter(Boolean),
    courses,
  };
}

export async function respond(input: { query: string; targetCity: string; kept: RankedRow[] }, ctx: StageContext): Promise<StageResult<RespondOutput>> {
  const warnings: string[] = [];
  const signal = (ms: number) => AbortSignal.any([ctx.signal, timeoutSignal(ms)]);
  const ids = input.kept.map((r) => r.id);
  const profiles = ids.length ? await ctx.deps.backend.getPartnerProfiles(ids, { signal: signal(ctx.config.callTimeoutMs) }) : [];
  const byId = new Map(profiles.map((p) => [p.partner_id, p]));

  const partners: AnswerPartner[] = [];
  const recommendations: Recommendation[] = [];
  for (const r of input.kept) {
    const p = byId.get(r.id);
    const profile = p?.llm_profile?.trim() || p?.body_markdown?.trim() || "";
    if (!p || !profile) { warnings.push(`Partner ${r.id} (${r.name}) has no profile text and was dropped from the answer.`); continue; }
    const rank = partners.length + 1;
    partners.push({ rank, name: p.title || r.name, city: p.city || r.city, role: r.role, distanceKm: r.distanceKm, profile });
    recommendations.push({ rank, id: r.id, name: p.title || r.name, city: p.city || r.city, role: r.role, distanceKm: r.distanceKm, finalScore: r.finalScore, relevance: r.relevance, profile, card: cardFromProfile(p) });
  }

  const prompt = buildAnswerPrompt({ query: input.query, targetCity: input.targetCity, partners });
  const r = await ctx.deps.llm.answer(prompt, { signal: signal(ctx.config.modelTimeoutMs) });
  const answer = r.text.trim();

  return {
    output: { answer, recommendations, profilesGiven: partners.length, model: ctx.deps.llm.modelName },
    config: { modelTimeoutMs: ctx.config.modelTimeoutMs },
    counts: { kept: input.kept.length, profilesFound: profiles.length, recommended: recommendations.length, promptChars: prompt.length },
    warnings,
    ...(r.usage ? { usage: r.usage } : {}),
    model: ctx.deps.llm.modelName,
  };
}
