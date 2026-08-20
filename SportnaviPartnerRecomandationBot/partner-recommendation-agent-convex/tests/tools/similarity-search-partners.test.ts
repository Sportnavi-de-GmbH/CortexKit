import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeConvex } from "./_fakes";

vi.mock("../../lib/embeddings", () => ({
  embedText: vi.fn(),
}));

import { embedText } from "../../lib/embeddings";
import { similaritySearchPartners } from "../../lib/partners/similarity-search-partners";

const rows = [
  {
    partner_id: 1,
    title: "Kletterhalle A",
    city: "Bochum",
    tags: ["klettern"],
    distance_km: null,
    similarity: 0.9,
    fts_rank: null,
    name_sim: null,
    tag_overlap: 1,
    rrf_score: 0.05,
  },
  {
    partner_id: 2,
    title: "Yoga B",
    city: "Bochum",
    tags: ["yoga"],
    distance_km: null,
    similarity: 0.2, // deliberately low — must still be returned (threshold is the orchestrator's job)
    fts_rank: null,
    name_sim: null,
    tag_overlap: 0,
    rrf_score: 0.01,
  },
];

describe("similaritySearchPartners", () => {
  afterEach(() => {
    vi.mocked(embedText).mockReset();
  });

  it("does not apply similarityThreshold — returns all backend hits regardless of similarity", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);
    const convex = fakeConvex({ matchPartners: rows });

    const { hits, warnings } = await similaritySearchPartners(
      { city: "Bochum", intent: { text: "Klettern", tags: [] }, k: 10 },
      convex,
    );

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.similarity)).toEqual([0.9, 0.2]);
    expect(warnings).toEqual([]);
  });

  it("degrades to text-only search when embedText throws, and returns a warning (E25)", async () => {
    vi.mocked(embedText).mockRejectedValue(new Error("provider unreachable"));
    const convex = fakeConvex({ matchPartners: rows });

    const { hits, warnings } = await similaritySearchPartners(
      { city: "Bochum", intent: { text: "Klettern", tags: [] }, k: 10 },
      convex,
    );

    expect(hits).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/degraded to text-only search/);
    expect(convex.callsTo("matchPartners")[0]!.args).toMatchObject({ queryEmbedding: null });
  });

  it("passes only the `city` filter key to match_partners (no unsupported is_active key)", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1]);
    const convex = fakeConvex({ matchPartners: [] });

    await similaritySearchPartners({ city: "Bochum", intent: { text: "x", tags: [] }, k: 5 }, convex);

    expect(convex.callsTo("matchPartners")[0]!.args).toMatchObject({ filters: { city: "Bochum" } });
  });

  it("requireTagMatch filters out hits with zero tag_overlap client-side", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1]);
    const convex = fakeConvex({ matchPartners: rows });

    const { hits } = await similaritySearchPartners(
      { city: "Bochum", intent: { text: "Klettern", tags: ["klettern"] }, k: 10, requireTagMatch: true },
      convex,
    );

    expect(hits.map((h) => h.id)).toEqual([1]);
  });

  it("skips tag filtering when requireTagMatch=true but intent has zero tags — never returns empty just for that (E30)", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1]);
    const convex = fakeConvex({ matchPartners: rows });

    const { hits } = await similaritySearchPartners(
      { city: "Bochum", intent: { text: "Klettern", tags: [] }, k: 10, requireTagMatch: true },
      convex,
    );

    // Both rows survive (including tag_overlap: 0) because there was nothing
    // to filter by — requireTagMatch only applies when intent.tags is non-empty.
    expect(hits.map((h) => h.id)).toEqual([1, 2]);
  });

  it("maps body_markdown and website_url to null (not returned by match_partners)", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1]);
    const convex = fakeConvex({ matchPartners: rows });

    const { hits } = await similaritySearchPartners(
      { city: "Bochum", intent: { text: "Klettern", tags: [] }, k: 10 },
      convex,
    );

    expect(hits[0].body_markdown).toBeNull();
    expect(hits[0].website_url).toBeNull();
  });
});

/**
 * Regression: `filters.tags` was never passed to match_partners. Inside the
 * RPC the `qtags` CTE is built from `filters->'tags'` (expanding through
 * tag_synonyms and okf.tag_variants) and the `tg` ranking CTE is guarded by
 * `cardinality(qtags.slugs) > 0` — so omitting the key left `tag_overlap` NULL
 * on every row. That killed one of the four RRF branches AND made the
 * client-side requireTagMatch filter discard 100% of candidates.
 */
describe("similaritySearchPartners — tag filter wiring", () => {
  const row = {
    partner_id: 1,
    title: "Studio",
    city: "Dortmund",
    tags: ["yoga"],
    distance_km: null,
    similarity: 0.8,
    fts_rank: null,
    name_sim: null,
    tag_overlap: 2,
    rrf_score: 0.03,
  };

  it("passes intent tags through to matchPartners' filters", async () => {
    const convex = fakeConvex({ matchPartners: [row] });
    await similaritySearchPartners(
      { city: "Dortmund", intent: { text: "yoga", tags: ["yoga", "pilates"] }, k: 5 },
      convex,
    );
    const args = convex.callsTo("matchPartners")[0]!.args as { filters: Record<string, unknown> };
    expect(args.filters).toEqual({ city: "Dortmund", tags: ["yoga", "pilates"] });
  });

  it("omits the tags key entirely when the intent carries none", async () => {
    const convex = fakeConvex({ matchPartners: [row] });
    await similaritySearchPartners(
      { city: "Dortmund", intent: { text: "sport", tags: [] }, k: 5 },
      convex,
    );
    const args = convex.callsTo("matchPartners")[0]!.args as { filters: Record<string, unknown> };
    expect(args.filters).toEqual({ city: "Dortmund" });
    expect("tags" in args.filters).toBe(false);
  });

  it("requireTagMatch keeps rows the backend scored as overlapping", async () => {
    const convex = fakeConvex({ matchPartners: [row] });
    const { hits } = await similaritySearchPartners(
      {
        city: "Dortmund",
        intent: { text: "yoga", tags: ["yoga"] },
        k: 5,
        requireTagMatch: true,
      },
      convex,
    );
    expect(hits).toHaveLength(1);
  });
});

describe("similaritySearchPartners — shared embedding", () => {
  const row = {
    partner_id: 1,
    title: "Studio",
    city: "Dortmund",
    tags: [],
    distance_km: null,
    similarity: 0.8,
    fts_rank: null,
    name_sim: null,
    tag_overlap: null,
    rrf_score: 0.03,
  };

  it("uses a pre-computed embedding instead of embedding again", async () => {
    // The orchestrator embeds once for the whole gap-fill fan-out; the
    // per-process embedding cache only fills after the first call RESOLVES, so
    // N concurrent cities previously issued N identical embedding requests.
    const convex = fakeConvex({ matchPartners: [row] });
    const vector = [0.1, 0.2, 0.3];
    const { warnings } = await similaritySearchPartners(
      { city: "Dortmund", intent: { text: "yoga", tags: [] }, k: 5, queryEmbedding: vector },
      convex,
    );
    const args = convex.callsTo("matchPartners")[0]!.args as { queryEmbedding: unknown };
    expect(args.queryEmbedding).toBe(vector);
    expect(warnings).toEqual([]);
  });

  it("propagates the orchestrator's degrade warning when the shared embed failed", async () => {
    const convex = fakeConvex({ matchPartners: [row] });
    const { warnings } = await similaritySearchPartners(
      {
        city: "Dortmund",
        intent: { text: "yoga", tags: [] },
        k: 5,
        queryEmbedding: null,
        embeddingWarning: "embedding unavailable (boom); degraded to text-only search",
      },
      convex,
    );
    const args = convex.callsTo("matchPartners")[0]!.args as { queryEmbedding: unknown };
    expect(args.queryEmbedding).toBeNull();
    expect(warnings).toEqual(["embedding unavailable (boom); degraded to text-only search"]);
  });

  it("applies a supplied AbortSignal to the matchPartners call", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);
    const convex = fakeConvex({ matchPartners: [row] });
    const controller = new AbortController();
    await similaritySearchPartners(
      { city: "Dortmund", intent: { text: "yoga", tags: [] }, k: 5 },
      convex,
      { signal: controller.signal },
    );
    const calls = convex.callsTo("matchPartners");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("forwards the AbortSignal into embedText when it has to embed itself", async () => {
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);
    const convex = fakeConvex({ matchPartners: [row] });
    const controller = new AbortController();
    await similaritySearchPartners(
      { city: "Dortmund", intent: { text: "yoga", tags: [] }, k: 5 },
      convex,
      { signal: controller.signal },
    );
    expect(embedText).toHaveBeenCalledWith("yoga", { signal: controller.signal });
  });
});
