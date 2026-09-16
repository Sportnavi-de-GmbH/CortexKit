/**
 * Stage 1 — Detect the city.
 * Order: config.targetCity (override) → stage 0's cityMention hint, or the city mentioned in the question (model) →
 * input.homeCity → input.sessionCities (most recent first). Every candidate is
 * resolved with the directory's fuzzy resolver; the first one at or above
 * cityConfidenceMin wins. No target ⇒ the runner asks the user — unless the
 * resolver itself failed (exception / timeout / run deadline), which throws
 * so the run fails visibly instead of asking the user for a city.
 */
import { raceAbort } from "../../lib/abortable";
import { timeoutSignal } from "../../lib/reused/timeout";
import type { CityAttempt, CitySource, DetectCityOutput, LlmUsage, ResolvedCity, StageContext, StageResult, WorkflowInput } from "../types";

async function resolve(mention: string, ctx: StageContext): Promise<ResolvedCity | null> {
  const signal = anySignal(ctx, ctx.config.callTimeoutMs);
  const row = await raceAbort(ctx.deps.backend.resolveCityFuzzy(mention, { signal }), signal, "resolve_city_fuzzy");
  if (!row) return null;
  return { canonical: row.city, centroid: { lat: row.lat, lng: row.lon }, confidence: row.sim };
}

function anySignal(ctx: StageContext, ms: number): AbortSignal {
  return AbortSignal.any([ctx.signal, timeoutSignal(ms)]);
}

export async function detectCity(input: WorkflowInput & { cityMention?: string | null }, ctx: StageContext): Promise<StageResult<DetectCityOutput>> {
  const warnings: string[] = [];
  const candidates: Array<{ source: CitySource; mention: string }> = [];
  let cityMention: string | null = null;
  let cityMentionSource: "override" | "hint" | "model" = "model";
  let usage: LlmUsage | undefined;

  if (ctx.config.targetCity) {
    cityMentionSource = "override";
    candidates.push({ source: "override", mention: ctx.config.targetCity });
  } else {
    if (input.cityMention !== undefined) {
      // Stage 0 already extracted the place for this task — no second model call.
      cityMentionSource = "hint";
      cityMention = input.cityMention?.trim() || null;
    } else {
      try {
        const signal = anySignal(ctx, ctx.config.modelTimeoutMs);
        const r = await raceAbort(ctx.deps.llm.detectCity(input.query, { signal }), signal, "detectCity");
        cityMention = r.cityMention;
        usage = r.usage;
      } catch (e) {
        warnings.push(`City detection model call failed (${(e as Error).message}); treating the question as having no city mention.`);
      }
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

  if (!target) {
    // An infrastructure failure (resolver exception, call timeout, run deadline)
    // is a stage ERROR, not "the user did not name a city": asking for
    // clarification would hide an outage. A genuine "no match / low
    // confidence" outcome still returns target: null (clarification).
    const infra = attempts.find((a) => a.reason?.startsWith("resolve_city_fuzzy failed"));
    if (ctx.signal.aborted || infra) {
      throw new Error(`city resolution failed: ${infra?.reason ?? "run aborted before a city could be resolved"}`);
    }
    warnings.push("No city could be determined from the question, the home city or the session.");
  }

  return {
    output: { cityMention, target, attempts },
    config: { cityConfidenceMin: ctx.config.cityConfidenceMin, targetCity: ctx.config.targetCity, cityMentionSource },
    counts: { attempts: attempts.length },
    warnings,
    ...(usage ? { usage, model: ctx.deps.llm.modelName } : {}),
  };
}
