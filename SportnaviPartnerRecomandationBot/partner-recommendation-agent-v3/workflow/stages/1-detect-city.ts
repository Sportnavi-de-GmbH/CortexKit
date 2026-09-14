/**
 * Stage 1 — Detect the city.
 * Order: config.targetCity (override) → city mentioned in the question (model) →
 * input.homeCity → input.sessionCities (most recent first). Every candidate is
 * resolved with the directory's fuzzy resolver; the first one at or above
 * cityConfidenceMin wins. No target ⇒ the runner asks the user.
 */
import { raceAbort } from "../../lib/abortable";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { CityAttempt, CitySource, DetectCityOutput, ResolvedCity, StageContext, StageResult, WorkflowInput } from "../types";

async function resolve(mention: string, ctx: StageContext): Promise<ResolvedCity | null> {
  const signal = anySignal(ctx);
  const row = await raceAbort(ctx.deps.backend.resolveCityFuzzy(mention, { signal }), signal, "resolve_city_fuzzy");
  if (!row) return null;
  return { canonical: row.city, centroid: { lat: row.lat, lng: row.lon }, confidence: row.sim };
}

function anySignal(ctx: StageContext): AbortSignal {
  return AbortSignal.any([ctx.signal, timeoutSignal(ctx.config.callTimeoutMs)]);
}

export async function detectCity(input: WorkflowInput, ctx: StageContext): Promise<StageResult<DetectCityOutput>> {
  const warnings: string[] = [];
  const candidates: Array<{ source: CitySource; mention: string }> = [];
  let cityMention: string | null = null;

  if (ctx.config.targetCity) {
    candidates.push({ source: "override", mention: ctx.config.targetCity });
  } else {
    try {
      const signal = anySignal(ctx);
      cityMention = (await raceAbort(ctx.deps.llm.detectCity(input.query, { signal }), signal, "detectCity")).cityMention;
    } catch (e) {
      warnings.push(`City detection model call failed (${(e as Error).message}); treating the question as having no city mention.`);
    }
    if (cityMention && cityMention.trim()) candidates.push({ source: "explicit", mention: cityMention.trim() });
    if (input.homeCity?.trim()) candidates.push({ source: "home", mention: input.homeCity.trim() });
    for (const c of input.sessionCities ?? []) if (c.trim()) candidates.push({ source: "session", mention: c.trim() });
  }

  const attempts: CityAttempt[] = [];
  let target: DetectCityOutput["target"] = null;
  for (const c of candidates) {
    let resolved: ResolvedCity | null = null;
    let reason: string | undefined;
    try {
      resolved = await resolve(c.mention, ctx);
    } catch (e) {
      reason = `resolve_city_fuzzy failed: ${(e as Error).message}`;
    }
    if (!resolved) reason ??= "no matching city in the directory";
    else if (resolved.confidence < ctx.config.cityConfidenceMin)
      reason = `confidence ${resolved.confidence} below cityConfidenceMin ${ctx.config.cityConfidenceMin}`;
    const accepted = resolved !== null && reason === undefined;
    attempts.push({ source: c.source, mention: c.mention, resolved, accepted, ...(reason ? { reason } : {}) });
    if (accepted && resolved) {
      target = { ...resolved, source: c.source, mention: c.mention };
      break;
    }
  }

  if (!target) warnings.push("No city could be determined from the question, the home city or the session.");

  return {
    output: { cityMention, target, attempts },
    config: { cityConfidenceMin: ctx.config.cityConfidenceMin, targetCity: ctx.config.targetCity },
    counts: { attempts: attempts.length },
    warnings,
  };
}
