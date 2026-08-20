/**
 * lib/convex-admin.ts — the SETUP-time Convex client.
 *
 * Kept strictly separate from lib/convex.ts, which is the request path. That
 * separation is the point: the `ConvexBackend` interface in lib/convex.ts
 * enumerates the five operations the agent performs per request, and if seed
 * and verification functions lived there, that list would stop meaning
 * anything. Nothing in agent/ imports this module.
 *
 * Used by scripts/seed-convex.ts, scripts/verify-convex-setup.ts and
 * scripts/generate-city-coverage.ts.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export interface PartnerSeedRow {
  sourceId: number;
  name: string;
  city: string | null;
  street: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  tags: string[];
  tagsNorm: string[];
  bodyMarkdown: string | null;
  coursesText: string | null;
  llmProfile: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  isActive: boolean;
  updatedAt: string | null;
  embeddingModel: string | null;
  lexA: string[];
  lexB: string[];
  lexC: string[];
  hasEmbedding: boolean;
}

export interface EmbeddingSeedRow {
  sourceId: number;
  cityLower: string;
  embedding: number[];
  embeddingModel: string | null;
  isActive: boolean;
}

export interface IntelligenceSeedRow {
  partnerId: number;
  qualityScore: number | null;
  contentQuality: number | null;
  courseQuality: number | null;
  tagQuality: number | null;
  contactQuality: number | null;
  locationQuality: number | null;
  isScrapeFailure: boolean;
  category: string | null;
}

export interface SetupCounts {
  partners: number;
  activePartners: number;
  partnerSearchDocs: number;
  partnerEmbeddings: number;
  partnerIntelligence: number;
  tagSynonyms: number;
  tagVariants: number;
  citySpellings: number;
  cityCentroids: number;
  cityCoverage: number;
}

export const adminRefs = {
  clearAll: makeFunctionReference<"action", { confirm: string }, { deleted: number }>(
    "migrations:clearAll",
  ),
  upsertPartnersBatch: makeFunctionReference<
    "mutation",
    { rows: PartnerSeedRow[] },
    { inserted: number; updated: number; searchDocs: number }
  >("migrations:upsertPartnersBatch"),
  upsertEmbeddingsBatch: makeFunctionReference<
    "mutation",
    { rows: EmbeddingSeedRow[] },
    { written: number; skipped: number }
  >("migrations:upsertEmbeddingsBatch"),
  upsertIntelligenceBatch: makeFunctionReference<
    "mutation",
    { rows: IntelligenceSeedRow[] },
    { written: number }
  >("migrations:upsertIntelligenceBatch"),
  upsertTagsBatch: makeFunctionReference<
    "mutation",
    {
      synonyms: Array<{ variantSlug: string; canonicalSlug: string }>;
      variants: Array<{ variantLower: string; tagSlug: string }>;
    },
    { synonyms: number; variants: number }
  >("migrations:upsertTagsBatch"),
  rebuildCityAggregates: makeFunctionReference<
    "action",
    Record<string, never>,
    { spellings: number; centroids: number; coverage: number; partnersScanned: number }
  >("migrations:rebuildCityAggregates"),
  recordMigration: makeFunctionReference<"mutation", { name: string; detail: string }, null>(
    "migrations:recordMigration",
  ),
  // An ACTION, not a query: counting 2,333 partner documents exceeds Convex's
  // 16 MB per-transaction read limit, so it paginates internally.
  verifySetup: makeFunctionReference<
    "action",
    Record<string, never>,
    {
      counts: SetupCounts;
      migrations: Array<{ name: string; appliedAt: number; detail: string }>;
    }
  >("migrations:verifySetup"),
  cityCoverage: makeFunctionReference<
    "query",
    Record<string, never>,
    Array<{ city: string; count: number }>
  >("cities:cityCoverage"),
} as const;

/**
 * Builds an HTTP client for the deployment named by `CONVEX_URL` (or
 * `NEXT_PUBLIC_CONVEX_URL`). Throws a clear error naming the variable —
 * never logs its value.
 */
export function getAdminConvex(): ConvexHttpClient {
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "getAdminConvex: missing CONVEX_URL (or NEXT_PUBLIC_CONVEX_URL). " +
        "Run `npx convex dev` once to provision a deployment — see SETUP.md.",
    );
  }
  return new ConvexHttpClient(url);
}
