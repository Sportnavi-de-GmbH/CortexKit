/**
 * Tiny generic TTL cache with lazy expiry (expired entries are evicted on
 * `get`, not via a timer). Accepts an injectable clock for deterministic
 * tests. Every `set()` also sweeps all already-expired entries out of the
 * underlying Map, so keys that are written once and never re-read (e.g. a
 * resolved-set handoff whose follow-up call never arrives) don't linger
 * forever in a long-running process.
 */

export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  /** Number of entries currently held, including any not-yet-swept expired ones. */
  size(): number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createTtlCache<T>(
  ttlSeconds: number,
  now: () => number = () => Date.now(),
  /**
   * Hard ceiling on entries. Expiry alone bounds a cache whose keyspace is
   * small (one centroid table), but not one keyed by user input — a search
   * cache keyed by city+intent can grow with traffic faster than the TTL
   * retires it. When full, the oldest inserted entry is evicted (Map
   * preserves insertion order). `Infinity` keeps the previous behaviour.
   */
  maxEntries: number = Number.POSITIVE_INFINITY,
): TtlCache<T> {
  const store = new Map<string, Entry<T>>();

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      if (now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      const nowMs = now();
      for (const [k, entry] of store) {
        if (nowMs >= entry.expiresAt) {
          store.delete(k);
        }
      }
      store.delete(key); // re-insert so refreshed keys count as newest
      store.set(key, { value, expiresAt: nowMs + ttlSeconds * 1000 });
      // Evict oldest-first if still over the ceiling after the sweep.
      while (store.size > maxEntries) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    clear(): void {
      store.clear();
    },
    size(): number {
      return store.size;
    },
  };
}
