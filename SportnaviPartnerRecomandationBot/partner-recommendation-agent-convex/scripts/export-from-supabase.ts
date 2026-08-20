/**
 * export-from-supabase.ts — STEP 1 of the data migration.
 *
 *   npx tsx scripts/export-from-supabase.ts
 *
 * Reads the live Supabase project and writes a self-contained JSONL snapshot
 * to `data/export/` that scripts/seed-convex.ts loads into Convex. Export and
 * import are separate steps on purpose:
 *
 *  - The snapshot is REPRODUCIBLE. Re-seeding a fresh Convex deployment from
 *    the same file gives byte-identical data, which is what makes repeated
 *    benchmark runs comparable rather than "whatever the directory looked like
 *    that day".
 *  - Seeding does not require Supabase credentials. Hand someone the export
 *    directory and they can stand up the Convex build with no access to the
 *    original project.
 *  - Embeddings are ~12 KB each; streaming them line-by-line keeps peak memory
 *    flat instead of holding 2,333 × 1536 floats in one array.
 *
 * ENV REQUIRED (same names as the Supabase build — see .env.local.example):
 *   MEMORY_SUPABASE_URL
 *   MEMORY_SUPABASE_SERVICE_ROLE_KEY
 *
 * The `partners` table has RLS enabled with NO policies, so the SERVICE ROLE
 * key is mandatory: the anon key returns zero rows silently.
 *
 * OUTPUT (data/export/):
 *   partners.jsonl      one PartnerSeedRow per line (no embedding)
 *   embeddings.jsonl    one { sourceId, cityLower, embedding, ... } per line
 *   intelligence.jsonl  one partner_intelligence row per line
 *   tags.json           { synonyms: [...], variants: [...] }
 *   manifest.json       row counts + timestamp, checked by the seed script
 */
import "../lib/load-env";

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { germanLexemes } from "../convex/lib/germanFts";
import type {
  EmbeddingSeedRow,
  IntelligenceSeedRow,
  PartnerSeedRow,
} from "../lib/convex-admin";

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/export",
);

/** PostgREST caps an unbounded response at db-max-rows (1,000 by default) and
 *  does it SILENTLY — the exact bug that hid 314 cities from the Supabase
 *  build for weeks (CLAUDE.md §10.9). Every read here is explicitly paged and
 *  the totals are cross-checked against a `count: "exact"` at the end. */
const PAGE = 500;
/** Embeddings are ~12 KB per row; a smaller page keeps each response sane. */
const EMBEDDING_PAGE = 100;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `export-from-supabase: missing required environment variable ${name}. ` +
        "See .env.local.example.",
    );
  }
  return value;
}

function supabase(): SupabaseClient {
  return createClient(
    requireEnv("MEMORY_SUPABASE_URL"),
    requireEnv("MEMORY_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

interface RawPartner {
  id: number;
  name: string;
  city: string | null;
  street: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  tags: string[] | null;
  tags_norm: string[] | null;
  body_markdown: string | null;
  courses_text: string | null;
  embedded_text: string | null;
  okf: string | null;
  llm_profile: string | null;
  email: string | null;
  phone: string | null;
  website_url: string | null;
  is_active: boolean;
  updated_at: string | null;
  embedding_model: string | null;
}

/** Everything except the vector — that is paged separately. */
const PARTNER_COLUMNS = [
  "id",
  "name",
  "city",
  "street",
  "postal_code",
  "latitude",
  "longitude",
  "tags",
  "tags_norm",
  "body_markdown",
  "courses_text",
  "embedded_text",
  "okf",
  "llm_profile",
  "email",
  "phone",
  "website_url",
  "is_active",
  "updated_at",
  "embedding_model",
].join(", ");

async function exportPartners(sb: SupabaseClient): Promise<{
  partners: number;
  withEmbedding: number;
}> {
  const out = createWriteStream(path.join(OUT_DIR, "partners.jsonl"), { encoding: "utf-8" });

  let written = 0;
  let withEmbedding = 0;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("partners")
      // `profile_embedding is not null` is needed to reproduce match_partners'
      // `base` predicate, but the vector itself is 12 KB — so ask only whether
      // it exists here, and fetch the values in exportEmbeddings().
      .select(`${PARTNER_COLUMNS}, has_embedding:profile_embedding`)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`export partners: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const raw of data as unknown as Array<RawPartner & { has_embedding: unknown }>) {
      const hasEmbedding = raw.has_embedding !== null && raw.has_embedding !== undefined;
      if (hasEmbedding) withEmbedding++;

      // The three tsvector weight sections of the `partners.fts` GENERATED
      // column, stemmed with the SAME module the Convex query path uses:
      //   A = name, B = courses_text, C = coalesce(embedded_text, okf)
      const row: PartnerSeedRow = {
        sourceId: raw.id,
        name: raw.name,
        city: raw.city,
        street: raw.street,
        postalCode: raw.postal_code,
        latitude: raw.latitude,
        longitude: raw.longitude,
        tags: raw.tags ?? [],
        tagsNorm: raw.tags_norm ?? [],
        bodyMarkdown: raw.body_markdown,
        coursesText: raw.courses_text,
        llmProfile: raw.llm_profile,
        email: raw.email,
        phone: raw.phone,
        websiteUrl: raw.website_url,
        isActive: raw.is_active,
        updatedAt: raw.updated_at,
        embeddingModel: raw.embedding_model,
        lexA: germanLexemes(raw.name),
        lexB: germanLexemes(raw.courses_text),
        lexC: germanLexemes(raw.embedded_text ?? raw.okf),
        hasEmbedding,
      };

      out.write(`${JSON.stringify(row)}\n`);
      written++;
    }

    process.stdout.write(`\r  partners: ${written}`);
    if (data.length < PAGE) break;
  }

  await new Promise<void>((resolve, reject) => out.end(() => resolve()).on("error", reject));
  process.stdout.write("\n");
  return { partners: written, withEmbedding };
}

async function exportEmbeddings(sb: SupabaseClient): Promise<number> {
  const out = createWriteStream(path.join(OUT_DIR, "embeddings.jsonl"), { encoding: "utf-8" });
  let written = 0;

  for (let from = 0; ; from += EMBEDDING_PAGE) {
    const { data, error } = await sb
      .from("partners")
      .select("id, city, is_active, embedding_model, profile_embedding")
      .not("profile_embedding", "is", null)
      .order("id", { ascending: true })
      .range(from, from + EMBEDDING_PAGE - 1);

    if (error) throw new Error(`export embeddings: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const raw of data as unknown as Array<{
      id: number;
      city: string | null;
      is_active: boolean;
      embedding_model: string | null;
      profile_embedding: number[] | string;
    }>) {
      // pgvector comes back over PostgREST as the string "[0.1,0.2,…]".
      const embedding =
        typeof raw.profile_embedding === "string"
          ? (JSON.parse(raw.profile_embedding) as number[])
          : raw.profile_embedding;

      if (!Array.isArray(embedding) || embedding.length !== 1536) {
        throw new Error(
          `export embeddings: partner ${raw.id} has a ${
            Array.isArray(embedding) ? embedding.length : "non-array"
          } embedding, expected 1536. Refusing to seed a mixed embedding space (E12).`,
        );
      }

      const row: EmbeddingSeedRow = {
        sourceId: raw.id,
        cityLower: (raw.city ?? "").toLowerCase(),
        embedding,
        embeddingModel: raw.embedding_model,
        isActive: raw.is_active,
      };
      out.write(`${JSON.stringify(row)}\n`);
      written++;
    }

    process.stdout.write(`\r  embeddings: ${written}`);
    if (data.length < EMBEDDING_PAGE) break;
  }

  await new Promise<void>((resolve, reject) => out.end(() => resolve()).on("error", reject));
  process.stdout.write("\n");
  return written;
}

async function exportIntelligence(sb: SupabaseClient): Promise<number> {
  const out = createWriteStream(path.join(OUT_DIR, "intelligence.jsonl"), {
    encoding: "utf-8",
  });
  let written = 0;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("partner_intelligence")
      .select(
        "partner_id, quality_score, content_quality, course_quality, tag_quality, contact_quality, location_quality, is_scrape_failure, category",
      )
      .order("partner_id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`export intelligence: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const raw of data as unknown as Array<Record<string, unknown>>) {
      const row: IntelligenceSeedRow = {
        partnerId: raw.partner_id as number,
        qualityScore: (raw.quality_score as number | null) ?? null,
        contentQuality: (raw.content_quality as number | null) ?? null,
        courseQuality: (raw.course_quality as number | null) ?? null,
        tagQuality: (raw.tag_quality as number | null) ?? null,
        contactQuality: (raw.contact_quality as number | null) ?? null,
        locationQuality: (raw.location_quality as number | null) ?? null,
        isScrapeFailure: Boolean(raw.is_scrape_failure),
        category: (raw.category as string | null) ?? null,
      };
      out.write(`${JSON.stringify(row)}\n`);
      written++;
    }

    process.stdout.write(`\r  intelligence: ${written}`);
    if (data.length < PAGE) break;
  }

  await new Promise<void>((resolve, reject) => out.end(() => resolve()).on("error", reject));
  process.stdout.write("\n");
  return written;
}

/**
 * `public.tag_synonyms` and `okf.tag_variants` — both read by match_partners'
 * qtags expansion. `okf` is a non-default schema, so it needs an explicit
 * `.schema("okf")` on the PostgREST client, and most Supabase projects do not
 * expose it through PostgREST by default.
 *
 * WHY A MISSING okf.tag_variants IS NOT AN ERROR
 *
 * In the RPC's `qraw` CTE that table only supplies the left side of
 * `coalesce(vm.slug, slugify_tag(x))`. Measured against the live database
 * (2026-08-12):
 *
 *   -- rows whose mapping differs from what slugify_tag() already returns
 *   select count(*) from (select distinct lower(variant) v, tag_slug s
 *                         from okf.tag_variants) t
 *   where public.slugify_tag(v) <> s;                                    -> 0
 *
 *   -- variants that fan out to more than one slug
 *   select count(*) from (select lower(variant) from okf.tag_variants
 *                         group by 1 having count(distinct tag_slug) > 1) t; -> 0
 *
 * All 706 rows map a variant to exactly the slug `slugify_tag()` produces, and
 * no variant maps to more than one slug — so the join is behaviourally a
 * no-op and exporting zero variants changes nothing about which partners are
 * retrieved. That is measured, not assumed, and re-checkable with the two
 * queries above if the table is ever edited.
 *
 * A permissions error here is therefore a warning, not a failed export.
 */
async function exportTags(
  sb: SupabaseClient,
): Promise<{ synonyms: number; variants: number }> {
  const { data: syn, error: synErr } = await sb
    .from("tag_synonyms")
    .select("variant_slug, canonical_slug");
  if (synErr) throw new Error(`export tag_synonyms: ${synErr.message}`);

  const { data: varRows, error: varErr } = await sb
    .schema("okf")
    .from("tag_variants")
    .select("variant, tag_slug");
  if (varErr) {
    console.warn(
      [
        "",
        `  WARNING: could not read okf.tag_variants (${varErr.message}).`,
        "  Continuing with ZERO variants. This is safe: every row in that table",
        "  maps a variant to the slug slugify_tag() already produces, so the qraw",
        "  coalesce() is a no-op. See this function's comment for the two queries",
        "  that prove it, and re-run them if the table has since been edited.",
        "  To include the rows anyway, expose the `okf` schema under",
        "  Supabase -> Settings -> API -> Exposed schemas, then re-run.",
        "",
      ].join("\n"),
    );
  }

  const synonyms = ((syn ?? []) as Array<{ variant_slug: string; canonical_slug: string }>).map(
    (r) => ({ variantSlug: r.variant_slug, canonicalSlug: r.canonical_slug }),
  );
  // The RPC's qraw CTE joins on `lower(variant)`, and dedupes with DISTINCT.
  const seen = new Set<string>();
  const variants: Array<{ variantLower: string; tagSlug: string }> = [];
  for (const r of (varRows ?? []) as Array<{ variant: string; tag_slug: string }>) {
    const key = `${r.variant.toLowerCase()}::${r.tag_slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ variantLower: r.variant.toLowerCase(), tagSlug: r.tag_slug });
  }

  await writeFile(
    path.join(OUT_DIR, "tags.json"),
    JSON.stringify({ synonyms, variants }, null, 2),
    "utf-8",
  );
  return { synonyms: synonyms.length, variants: variants.length };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const sb = supabase();

  console.log(`Exporting Supabase -> ${OUT_DIR}\n`);

  const { partners, withEmbedding } = await exportPartners(sb);
  const embeddings = await exportEmbeddings(sb);
  const intelligence = await exportIntelligence(sb);
  const tags = await exportTags(sb);

  // Cross-check against an authoritative count. A paged export that silently
  // stops short is the same class of bug as §10.9, and it would show up in the
  // Convex build as "this city has fewer partners" — indistinguishable from a
  // genuinely thin city unless it is asserted here.
  const { count: expected, error: countErr } = await sb
    .from("partners")
    .select("id", { count: "exact", head: true });
  if (countErr) throw new Error(`count check: ${countErr.message}`);
  if (expected !== null && expected !== partners) {
    throw new Error(
      `export incomplete: wrote ${partners} partners but the table has ${expected}. ` +
        "Refusing to write a manifest for a truncated export.",
    );
  }
  if (withEmbedding !== embeddings) {
    throw new Error(
      `export inconsistent: ${withEmbedding} partners report an embedding but ` +
        `${embeddings} vectors were exported.`,
    );
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    source: "supabase",
    counts: { partners, embeddings, intelligence, ...tags },
  };
  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  console.log("\nExport complete:");
  console.log(JSON.stringify(manifest, null, 2));
  console.log("\nNext: npm run convex:seed");
}

main().catch((err) => {
  console.error("\nEXPORT FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
