/**
 * Stage 6 — Hydrate the kept partners' profiles (one batched call) and let
 * the model phrase the answer from those profiles ONLY. A missing profile
 * drops that partner (the cut was fixed in stage 5, so UI and answer agree);
 * survivors are renumbered 1..N; no partner beyond the stage-5 cut is added.
 */
import { timeoutSignal } from "../../lib/reused/timeout";
import { buildAnswerPrompt, type AnswerPartner } from "./answer-prompt";
import type { RankedRow, Recommendation, RespondOutput, StageContext, StageResult } from "../types";

export async function respond(input: { query: string; targetCity: string; kept: RankedRow[] }, ctx: StageContext): Promise<StageResult<RespondOutput>> {
  const warnings: string[] = [];
  const signal = () => AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
  const ids = input.kept.map((r) => r.id);
  const profiles = ids.length ? await ctx.deps.backend.getPartnerProfiles(ids, { signal: signal() }) : [];
  const byId = new Map(profiles.map((p) => [p.partner_id, p]));

  const partners: AnswerPartner[] = [];
  const recommendations: Recommendation[] = [];
  for (const r of input.kept) {
    const p = byId.get(r.id);
    const profile = p?.llm_profile?.trim() || p?.body_markdown?.trim() || "";
    if (!p || !profile) { warnings.push(`Partner ${r.id} (${r.name}) has no profile text and was dropped from the answer.`); continue; }
    const rank = partners.length + 1;
    partners.push({ rank, name: p.title || r.name, city: p.city || r.city, role: r.role, distanceKm: r.distanceKm, profile });
    recommendations.push({ rank, id: r.id, name: p.title || r.name, city: p.city || r.city, role: r.role, distanceKm: r.distanceKm, finalScore: r.finalScore, relevance: r.relevance, profile });
  }

  const prompt = buildAnswerPrompt({ query: input.query, targetCity: input.targetCity, partners });
  const answer = (await ctx.deps.llm.answer(prompt, { signal: signal() })).trim();

  return {
    output: { answer, recommendations, profilesGiven: partners.length, model: ctx.deps.llm.modelName },
    config: {},
    counts: { kept: input.kept.length, profilesFound: profiles.length, recommended: recommendations.length, promptChars: prompt.length },
    warnings,
  };
}
