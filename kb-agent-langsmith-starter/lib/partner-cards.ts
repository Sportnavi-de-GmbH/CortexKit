/**
 * Partner cards — reading the V2 partner agent's structured result out of a
 * chat message.
 *
 * eve streams a tool's FULL `execute()` return value to the browser as a
 * `dynamic-tool` message part (only `toModelOutput` trims what the model
 * sees), and the proxy relays that stream byte-for-byte. The V2 agent puts a
 * `card` on every recommendation (see its `search/types.ts` — `PartnerCard`);
 * this module turns that into what `PartnerCards` renders.
 *
 * Contract, in order of importance:
 *  1. Anything that is not the V2 `{ kind: "results" }` shape yields `null`.
 *     The live Supabase agent returns a different object, and with it the
 *     widget must behave exactly as it did before cards existed.
 *  2. Never throw. A malformed card is skipped; a missing field is `null`
 *     (eve's serializer drops `undefined` keys on the wire).
 *  3. URLs are re-validated here even though the agent already did — the data
 *     crosses a service boundary, and an `<img src>` / `<a href>` is where it
 *     would bite.
 *
 * Pure so it can be tested without a DOM.
 */

export interface PartnerCardData {
  partnerId: number;
  name: string;
  logoUrl: string | null;
  city: string | null;
  street: string | null;
  postalCode: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  tags: string[];
  description: string | null;
  openingHours: string | null;
  /** Where this partner came from, for the location line. */
  source: "requested" | "nearby";
  sourceCity: string | null;
  distanceKm: number;
}

export interface PartnerCardGroup {
  /** "<sport> in <city>" — the request this list answers. */
  label: string;
  cards: PartnerCardData[];
}

export const PARTNER_TOOL_NAME = "find_partners";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Cards for the most recent completed `find_partners` call in `parts`, or
 * `null` when there is nothing to show.
 */
export function extractPartnerCards(parts: readonly unknown[]): PartnerCardGroup[] | null {
  let output: Rec | null = null;
  for (const part of parts) {
    if (!isRec(part)) continue;
    if (part.type !== "dynamic-tool" || part.toolName !== PARTNER_TOOL_NAME || part.state !== "output-available") continue;
    if (isRec(part.output)) output = part.output; // last one wins
  }
  if (output === null || output.kind !== "results" || !Array.isArray(output.results)) return null;

  const groups: PartnerCardGroup[] = [];
  for (const result of output.results) {
    if (!isRec(result) || result.status !== "ok" || !Array.isArray(result.recommendations)) continue;
    const cards = result.recommendations.map(toCard).filter((c): c is PartnerCardData => c !== null);
    if (cards.length === 0) continue;
    groups.push({ label: labelOf(result), cards });
  }
  return groups.length > 0 ? groups : null;
}

function labelOf(result: Rec): string {
  const request = isRec(result.request) ? result.request : {};
  const sport = str(request.sport) ?? "Sport";
  const city = str(result.requestedCity) ?? str(request.city) ?? "";
  return city ? `${sport} in ${city}` : sport;
}

function toCard(recommendation: unknown): PartnerCardData | null {
  if (!isRec(recommendation) || !isRec(recommendation.card)) return null;
  const card = recommendation.card;
  const partnerId = num(card.partnerId) ?? num(recommendation.partnerId);
  const name = str(card.name) ?? str(recommendation.name);
  if (partnerId === null || name === null) return null;
  const source = recommendation.source === "nearby" ? "nearby" : "requested";
  return {
    partnerId,
    name,
    logoUrl: url(card.logoUrl, ["https:"]),
    city: str(card.city),
    street: str(card.street),
    postalCode: str(card.postalCode),
    email: str(card.email),
    phone: str(card.phone),
    websiteUrl: url(card.websiteUrl, ["https:", "http:"]),
    tags: Array.isArray(card.tags) ? card.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [],
    description: str(card.description),
    openingHours: str(card.openingHours),
    source,
    sourceCity: str(recommendation.sourceCity),
    distanceKm: num(recommendation.distanceKm) ?? 0,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function url(v: unknown, protocols: readonly string[]): string | null {
  const s = str(v);
  if (s === null) return null;
  try {
    return protocols.includes(new URL(s).protocol) ? s : null;
  } catch {
    return null;
  }
}
