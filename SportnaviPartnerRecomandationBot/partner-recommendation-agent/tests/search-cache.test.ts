import { describe, expect, it, beforeEach } from "vitest";

import { createTtlCache } from "../lib/cache";
import {
  getCachedSearch,
  invalidateSearchCache,
  searchCacheKey,
  searchCacheSize,
  setCachedSearch,
} from "../lib/partners/search-cache";

/**
 * The search cache short-circuits 5-10 serialized database round-trips, so a
 * key collision would serve one city's partners for another city's request.
 * These tests pin the key contract and the memory ceiling.
 */
describe("searchCacheKey", () => {
  it("normalizes city casing and whitespace to one entry", () => {
    const base = { tags: ["yoga"], finalRecommendations: 5, intentText: "Yoga" };
    const a = searchCacheKey({ ...base, cityMention: "Dortmund" });
    const b = searchCacheKey({ ...base, cityMention: "  dortmund " });
    const c = searchCacheKey({ ...base, cityMention: "DORTMUND" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("is order-insensitive for tags", () => {
    const base = { cityMention: "Dortmund", finalRecommendations: 5, intentText: "Yoga" };
    expect(searchCacheKey({ ...base, tags: ["yoga", "pilates"] })).toBe(
      searchCacheKey({ ...base, tags: ["pilates", "yoga"] }),
    );
  });

  it("separates different cities", () => {
    const base = { tags: ["yoga"], finalRecommendations: 5, intentText: "Yoga" };
    expect(searchCacheKey({ ...base, cityMention: "Dortmund" })).not.toBe(
      searchCacheKey({ ...base, cityMention: "Bochum" }),
    );
  });

  it("separates different tag sets — they change which partners come back", () => {
    const base = { cityMention: "Dortmund", finalRecommendations: 5, intentText: "Sport" };
    expect(searchCacheKey({ ...base, tags: ["yoga"] })).not.toBe(
      searchCacheKey({ ...base, tags: ["klettern"] }),
    );
    expect(searchCacheKey({ ...base, tags: [] })).not.toBe(
      searchCacheKey({ ...base, tags: ["yoga"] }),
    );
  });

  it("separates different result counts — 5 picks is not a prefix of 8", () => {
    const base = { cityMention: "Dortmund", tags: ["yoga"], intentText: "Yoga" };
    expect(searchCacheKey({ ...base, finalRecommendations: 5 })).not.toBe(
      searchCacheKey({ ...base, finalRecommendations: 8 }),
    );
  });

  // REGRESSION: intentText was excluded from the key on the grounds that only
  // `tags` steer retrieval. It does not — intentText IS the embedding query
  // that decides which partners gap-fill returns, and `tags` is model-supplied
  // and frequently empty. Two unrelated requests therefore collided and the
  // second was served the first one's partners AND disclosure for up to an hour.
  it("separates different intents even when city and tags are identical", () => {
    const base = { cityMention: "Bochum", tags: [], finalRecommendations: 5 };
    expect(searchCacheKey({ ...base, intentText: "Kletterkurse für Anfänger" })).not.toBe(
      searchCacheKey({ ...base, intentText: "Yoga zum Stressabbau" }),
    );
  });

  it("normalizes intent casing and whitespace so trivial rewording still hits", () => {
    const base = { cityMention: "Bochum", tags: ["yoga"], finalRecommendations: 5 };
    expect(searchCacheKey({ ...base, intentText: "Yoga  für Anfänger" })).toBe(
      searchCacheKey({ ...base, intentText: " yoga für anfänger " }),
    );
  });
});

describe("search cache store", () => {
  beforeEach(() => invalidateSearchCache());

  it("round-trips a value and can be invalidated after a partner import", () => {
    const key = searchCacheKey({
      cityMention: "Dortmund",
      tags: [],
      finalRecommendations: 5,
      intentText: "Yoga",
    });
    setCachedSearch(key, { marker: 1 });
    expect(getCachedSearch(key)).toEqual({ marker: 1 });

    invalidateSearchCache();
    expect(getCachedSearch(key)).toBeUndefined();
    expect(searchCacheSize()).toBe(0);
  });

  it("misses for an unseen key rather than returning a neighbour's result", () => {
    setCachedSearch(
      searchCacheKey({
        cityMention: "Dortmund",
        tags: [],
        finalRecommendations: 5,
        intentText: "Yoga",
      }),
      { city: "Dortmund" },
    );
    const other = searchCacheKey({
      cityMention: "Bochum",
      tags: [],
      finalRecommendations: 5,
      intentText: "Yoga",
    });
    expect(getCachedSearch(other)).toBeUndefined();
  });

  it("does not serve a climbing search to a yoga request in the same city", () => {
    const base = { cityMention: "Bochum", tags: [], finalRecommendations: 5 };
    setCachedSearch(
      searchCacheKey({ ...base, intentText: "Kletterkurse für Anfänger" }),
      { intent: "klettern" },
    );
    expect(
      getCachedSearch(searchCacheKey({ ...base, intentText: "Yoga zum Stressabbau" })),
    ).toBeUndefined();
  });
});

describe("createTtlCache — bounding", () => {
  it("evicts oldest-first once maxEntries is exceeded", () => {
    const cache = createTtlCache<number>(3600, () => Date.now(), 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toBeUndefined(); // oldest, evicted
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("treats a refreshed key as newest, so it is not evicted next", () => {
    const cache = createTtlCache<number>(3600, () => Date.now(), 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11); // refresh 'a' — now newer than 'b'
    cache.set("c", 3);

    expect(cache.get("a")).toBe(11);
    expect(cache.get("b")).toBeUndefined(); // now the oldest
    expect(cache.get("c")).toBe(3);
  });

  it("is unbounded by default (existing callers keep their behaviour)", () => {
    const cache = createTtlCache<number>(3600);
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i);
    expect(cache.size()).toBe(50);
  });

  it("still expires by TTL independently of the ceiling", () => {
    let now = 0;
    const cache = createTtlCache<number>(10, () => now, 10);
    cache.set("a", 1);
    now = 10_001;
    expect(cache.get("a")).toBeUndefined();
  });
});
