/**
 * tests/supabase-backend.test.ts — the adapter itself.
 *
 * Every other unit test in this suite exercises lib/partners/* against the
 * six-method fake (tests/tools/_fakes.ts), exactly as the Convex reference
 * does. This file is the one place the REAL adapter is tested, against a
 * stubbed supabase-js client: it pins the RPC names, the camelCase→snake_case
 * argument translation, the pgvector decoding, the abort wiring and the
 * two-query intelligence join — the things that would silently break parity
 * if they drifted.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseBackend, decodeVector, PARTNER_SELECT_COLUMNS } from "../lib/supabase";

// ─── A minimal chainable stub of supabase-js ────────────────────────────────

interface Recorded {
  kind: "rpc" | "from";
  name: string;
  args?: unknown;
  chain: Array<{ op: string; args: unknown[] }>;
  signal?: AbortSignal;
}

type Canned = { data: unknown; error: { message: string } | null };

function stubClient(
  answers: (call: Recorded) => Canned,
): { client: SupabaseClient; calls: Recorded[] } {
  const calls: Recorded[] = [];

  const builder = (rec: Recorded) => {
    const b: Record<string, unknown> = {};
    const chainable = (op: string) =>
      (...args: unknown[]) => {
        rec.chain.push({ op, args });
        if (op === "abortSignal") rec.signal = args[0] as AbortSignal;
        return b;
      };
    for (const op of ["select", "in", "eq", "overlaps", "not", "abortSignal", "order", "range"]) {
      b[op] = chainable(op);
    }
    // Thenable, so `await q` works like a PostgrestBuilder.
    b.then = (resolve: (v: Canned) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => answers(rec))
        .then(resolve, reject);
    return b;
  };

  const client = {
    rpc: (name: string, args?: unknown) => {
      const rec: Recorded = { kind: "rpc", name, args, chain: [] };
      calls.push(rec);
      return builder(rec);
    },
    from: (name: string) => {
      const rec: Recorded = { kind: "from", name, chain: [] };
      calls.push(rec);
      return builder(rec);
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

const ok = (data: unknown): Canned => ({ data, error: null });
const fail = (message: string): Canned => ({ data: null, error: { message } });

// ─── resolveCityFuzzy ───────────────────────────────────────────────────────

describe("resolveCityFuzzy", () => {
  it("calls resolve_city_fuzzy(place) and returns the first row or null", async () => {
    const { client, calls } = stubClient(() =>
      ok([{ city: "Bochum", lat: 51.48, lon: 7.22, sim: 1 }]),
    );
    const row = await createSupabaseBackend(client).resolveCityFuzzy("bochum");
    expect(row).toEqual({ city: "Bochum", lat: 51.48, lon: 7.22, sim: 1 });
    expect(calls[0]).toMatchObject({ kind: "rpc", name: "resolve_city_fuzzy", args: { place: "bochum" } });
  });

  it("returns null on an empty result and throws on an RPC error", async () => {
    const empty = stubClient(() => ok([]));
    expect(await createSupabaseBackend(empty.client).resolveCityFuzzy("nowhere")).toBeNull();

    const broken = stubClient(() => fail("Could not find the function"));
    await expect(createSupabaseBackend(broken.client).resolveCityFuzzy("x")).rejects.toThrow(
      /resolve_city_fuzzy RPC failed: Could not find the function/,
    );
  });

  it("forwards the AbortSignal to .abortSignal()", async () => {
    const { client, calls } = stubClient(() => ok([]));
    const ac = new AbortController();
    await createSupabaseBackend(client).resolveCityFuzzy("x", { signal: ac.signal });
    expect(calls[0]!.signal).toBe(ac.signal);
  });
});

// ─── getPartnersByCity ──────────────────────────────────────────────────────

describe("getPartnersByCity", () => {
  const partner = (id: number, city = "Bochum") => ({
    id,
    name: `P${id}`,
    city,
    tags_norm: ["yoga"],
    body_markdown: null,
    website_url: null,
    is_active: true,
    updated_at: null,
  });

  it("selects the fixed projection, filters active by default, then joins quality_score", async () => {
    const { client, calls } = stubClient((call) =>
      call.name === "partners"
        ? ok([partner(1), partner(2)])
        : ok([{ partner_id: 2, quality_score: 0.8 }]),
    );
    const rows = await createSupabaseBackend(client).getPartnersByCity({
      aliases: ["Bochum", "bochum"],
    });

    expect(calls.map((c) => c.name)).toEqual(["partners", "partner_intelligence"]);
    const q = calls[0]!.chain;
    expect(q).toContainEqual({ op: "select", args: [PARTNER_SELECT_COLUMNS] });
    expect(q).toContainEqual({ op: "in", args: ["city", ["Bochum", "bochum"]] });
    expect(q).toContainEqual({ op: "eq", args: ["is_active", true] });
    expect(q.some((c) => c.op === "overlaps")).toBe(false);

    expect(calls[1]!.chain).toContainEqual({ op: "in", args: ["partner_id", [1, 2]] });
    expect(rows.map((r) => [r.id, r.quality_score])).toEqual([
      [1, null],
      [2, 0.8],
    ]);
  });

  it("applies tagFilter as an overlaps() and includeInactive drops the is_active filter", async () => {
    const { client, calls } = stubClient(() => ok([]));
    await createSupabaseBackend(client).getPartnersByCity({
      aliases: ["Bochum"],
      tagFilter: ["yoga", "pilates"],
      includeInactive: true,
    });
    const q = calls[0]!.chain;
    expect(q).toContainEqual({ op: "overlaps", args: ["tags_norm", ["yoga", "pilates"]] });
    expect(q.some((c) => c.op === "eq")).toBe(false);
    // No rows → no intelligence query at all.
    expect(calls).toHaveLength(1);
  });

  it("dedupes by id across overlapping aliases", async () => {
    const { client } = stubClient((call) =>
      call.name === "partners" ? ok([partner(7), partner(7, "bochum")]) : ok([]),
    );
    const rows = await createSupabaseBackend(client).getPartnersByCity({ aliases: ["Bochum", "bochum"] });
    expect(rows).toHaveLength(1);
  });

  it("returns [] for no aliases without touching the database", async () => {
    const { client, calls } = stubClient(() => ok([]));
    expect(await createSupabaseBackend(client).getPartnersByCity({ aliases: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("treats an intelligence-join failure as best-effort (rows still returned)", async () => {
    const { client } = stubClient((call) =>
      call.name === "partners" ? ok([partner(1)]) : fail("permission denied"),
    );
    const rows = await createSupabaseBackend(client).getPartnersByCity({ aliases: ["Bochum"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quality_score).toBeNull();
  });

  it("propagates the signal to BOTH queries", async () => {
    const { client, calls } = stubClient((call) =>
      call.name === "partners" ? ok([partner(1)]) : ok([]),
    );
    const ac = new AbortController();
    await createSupabaseBackend(client).getPartnersByCity({ aliases: ["Bochum"] }, { signal: ac.signal });
    expect(calls[0]!.signal).toBe(ac.signal);
    expect(calls[1]!.signal).toBe(ac.signal);
  });
});

// ─── cityCentroids ──────────────────────────────────────────────────────────

describe("cityCentroids", () => {
  it("reads the city_centroids() RPC verbatim", async () => {
    const rows = [{ city: "Bochum", lat: 51.4, lon: 7.2, cnt: 30 }];
    const { client, calls } = stubClient(() => ok(rows));
    expect(await createSupabaseBackend(client).cityCentroids()).toEqual(rows);
    expect(calls[0]).toMatchObject({ kind: "rpc", name: "city_centroids" });
  });
});

// ─── matchPartners ──────────────────────────────────────────────────────────

describe("matchPartners", () => {
  it("translates camelCase args to the RPC's snake_case exactly once", async () => {
    const { client, calls } = stubClient(() => ok([]));
    const embedding = [0.1, 0.2];
    await createSupabaseBackend(client).matchPartners({
      queryEmbedding: embedding,
      queryText: "Yoga",
      filters: { city: "Bochum", tags: ["yoga"], excludeIds: [1, 2] },
      matchCount: 40,
    });
    expect(calls[0]).toMatchObject({
      kind: "rpc",
      name: "match_partners",
      args: {
        query_embedding: embedding,
        query_text: "Yoga",
        filters: { city: "Bochum", tags: ["yoga"], exclude_ids: [1, 2] },
        match_count: 40,
      },
    });
  });

  it("omits absent filter keys instead of sending undefined (the RPC reads filters->'tags')", async () => {
    const { client, calls } = stubClient(() => ok([]));
    await createSupabaseBackend(client).matchPartners({
      queryEmbedding: null,
      queryText: "Yoga",
      filters: { city: "Bochum" },
      matchCount: 10,
    });
    const args = calls[0]!.args as { filters: Record<string, unknown>; query_embedding: unknown };
    expect(Object.keys(args.filters)).toEqual(["city"]);
    expect(args.query_embedding).toBeNull();
  });

  it("wraps an RPC error with the function name", async () => {
    const { client } = stubClient(() => fail("canceling statement due to statement timeout"));
    await expect(
      createSupabaseBackend(client).matchPartners({
        queryEmbedding: null,
        queryText: "x",
        filters: {},
        matchCount: 1,
      }),
    ).rejects.toThrow(/match_partners RPC failed: canceling statement/);
  });
});

// ─── getPartnerProfiles ─────────────────────────────────────────────────────

describe("getPartnerProfiles", () => {
  it("calls get_partner_profiles(p_ids) and returns the rows untouched", async () => {
    const row = { partner_id: 5, title: "Studio", llm_profile: "…", profile_data: { a: 1 } };
    const { client, calls } = stubClient(() => ok([row]));
    const rows = await createSupabaseBackend(client).getPartnerProfiles([5, 6]);
    expect(rows).toEqual([row]);
    expect(calls[0]).toMatchObject({ name: "get_partner_profiles", args: { p_ids: [5, 6] } });
  });

  it("short-circuits an empty id list", async () => {
    const { client, calls } = stubClient(() => ok([]));
    expect(await createSupabaseBackend(client).getPartnerProfiles([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ─── getPartnerEmbeddings + decodeVector ────────────────────────────────────

describe("getPartnerEmbeddings", () => {
  const vec = Array.from({ length: 1536 }, (_, i) => i / 1536);

  it("reads id + profile_embedding for the ids, skipping null vectors server-side", async () => {
    const { client, calls } = stubClient(() =>
      ok([
        { id: 1, profile_embedding: JSON.stringify(vec) }, // pgvector text form
        { id: 2, profile_embedding: vec }, // already-decoded form
      ]),
    );
    const rows = await createSupabaseBackend(client).getPartnerEmbeddings([1, 2, 3]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows[0]!.embedding).toHaveLength(1536);
    expect(rows[0]!.embedding[1]).toBeCloseTo(1 / 1536);
    const q = calls[0]!.chain;
    expect(q).toContainEqual({ op: "select", args: ["id, profile_embedding"] });
    expect(q).toContainEqual({ op: "in", args: ["id", [1, 2, 3]] });
    expect(q).toContainEqual({ op: "not", args: ["profile_embedding", "is", null] });
  });

  it("refuses a vector of the wrong dimensionality (mixed embedding space, E12)", async () => {
    const { client } = stubClient(() => ok([{ id: 9, profile_embedding: "[0.1,0.2,0.3]" }]));
    await expect(createSupabaseBackend(client).getPartnerEmbeddings([9])).rejects.toThrow(
      /partner 9 has a 3-dim embedding, expected 1536/,
    );
  });

  it("decodeVector rejects non-numeric payloads", () => {
    expect(() => decodeVector('["a","b"]', 1)).toThrow(/non-numeric/);
    expect(() => decodeVector({ not: "an array" }, 1)).toThrow(/non-numeric/);
  });

  it("short-circuits an empty id list", async () => {
    const { client, calls } = stubClient(() => ok([]));
    expect(await createSupabaseBackend(client).getPartnerEmbeddings([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
