import { describe, expect, it } from "vitest";
import { createTtlCache } from "../lib/cache";

describe("createTtlCache", () => {
  it("returns undefined for a missing key", () => {
    const cache = createTtlCache<string>(60);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a value before it expires", () => {
    let now = 0;
    const cache = createTtlCache<string>(10, () => now);
    cache.set("a", "value-a");
    now += 5_000; // 5s elapsed, ttl is 10s
    expect(cache.get("a")).toBe("value-a");
  });

  it("expires a value lazily once the TTL has elapsed", () => {
    let now = 0;
    const cache = createTtlCache<string>(10, () => now);
    cache.set("a", "value-a");
    now += 10_000; // exactly at ttl boundary -> expired
    expect(cache.get("a")).toBeUndefined();
  });

  it("expires well past the TTL", () => {
    let now = 0;
    const cache = createTtlCache<number>(1, () => now);
    cache.set("k", 42);
    now += 60_000;
    expect(cache.get("k")).toBeUndefined();
  });

  it("clear() removes all entries", () => {
    let now = 0;
    const cache = createTtlCache<string>(60, () => now);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("overwriting a key resets its TTL", () => {
    let now = 0;
    const cache = createTtlCache<string>(10, () => now);
    cache.set("a", "first");
    now += 8_000;
    cache.set("a", "second");
    now += 8_000; // 8s after the second set, well within its own 10s ttl
    expect(cache.get("a")).toBe("second");
  });

  it("sweeps expired entries out of the underlying store on set(), even when they are never get()-ed", () => {
    let now = 0;
    const cache = createTtlCache<string>(10, () => now);
    cache.set("a", "value-a");
    cache.set("b", "value-b");
    expect(cache.size()).toBe(2);

    now += 20_000; // both entries now well past their ttl, neither has been read
    cache.set("c", "value-c"); // sweep should run as part of this set()

    // "a" and "b" must be gone from the underlying Map, not just lazily
    // reported as missing on a future get() — size() proves real eviction.
    expect(cache.size()).toBe(1);
    expect(cache.get("c")).toBe("value-c");
  });
});
