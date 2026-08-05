/**
 * lib/partners/search-cache.ts
 *
 * Memoizes a whole partner search — city resolution, home fetch, gap-fill and
 * profile hydration — behind one key.
 *
 * WHY THIS IS SAFE HERE: the partner directory changes daily at most (owner
 * confirmed). A search is a pure function of (city, intent tags, how many to
 * return) over that directory, so within a short TTL the same request must
 * produce the same answer. Re-deriving it costs 5-10 serialized round-trips.
 *
 * WHY IT PAYS: traffic concentrates on a handful of large cities (Bielefeld
 * alone has 100 partners, and the top 40 cities dwarf the ~350 that have a
 * single partner). The second request for a popular city skips the database
 * entirely.
 *
 * SCOPE AND LIMITS — read before relying on it:
 *  - **Per-process, in-memory.** Nothing is shared across instances, and a
 *    restart clears it. That is fine for a latency cache; it is not a store.
 *  - **Bounded**, so an unbounded keyspace (city x intent is user-driven)
 *    cannot grow without limit.
 *  - **Not for personalized results.** The key must contain everything that
 *    can change the outcome. If per-user filtering is ever added, it has to
 *    go into the key or this becomes a cross-user data leak.
 *  - `invalidateSearchCache()` is the hook to call after a partner import.
 */
import { createTtlCache } from "../cache";

/** Long enough to absorb bursts on popular cities, short enough that a daily
 *  import is visible the same day without an explicit invalidation call. */
const SEARCH_TTL_SEC = 3600; // 1 hour

/** Ceiling on distinct (city, tags, n) combinations held at once. */
const MAX_ENTRIES = 500;

const cache = createTtlCache<unknown>(SEARCH_TTL_SEC, () => Date.now(), MAX_ENTRIES);

/**
 * Everything that can change the result must be in the key. `cityMention` is
 * normalized (case/whitespace) so "Dortmund", "dortmund " and "DORTMUND" share
 * an entry — they resolve to the same canonical city anyway. Tags are sorted
 * so ordering never splits the cache.
 *
 * `intentText` IS part of the key. It was previously excluded on the grounds
 * that it "is used solely as the embedding query during gap-fill" — but that
 * is exactly why it belongs here: the embedding query *decides which partners
 * gap-fill returns*. `tags` is model-supplied and frequently empty, so without
 * intentText two unrelated requests collided:
 *
 *   ("Bochum", [], "Kletterkurse für Anfänger")  ->  bochum::::100
 *   ("Bochum", [], "Yoga zum Stressabbau")       ->  bochum::::100   ← same key
 *
 * The second request was served the first one's climbing partners, together
 * with the first one's disclosure, for up to an hour. Hit rate matters less
 * than answering the question that was actually asked.
 */
export function searchCacheKey(args: {
  cityMention: string;
  tags: readonly string[];
  finalRecommendations: number;
  intentText: string;
}): string {
  const city = args.cityMention.trim().toLowerCase().replace(/\s+/g, " ");
  const tags = [...args.tags].map((t) => t.trim().toLowerCase()).sort().join("|");
  const intent = args.intentText.trim().toLowerCase().replace(/\s+/g, " ");
  return `${city}::${tags}::${args.finalRecommendations}::${intent}`;
}

export function getCachedSearch<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setCachedSearch<T>(key: string, value: T): void {
  cache.set(key, value);
}

/** Call after a partner import so stale shortlists don't linger for the TTL. */
export function invalidateSearchCache(): void {
  cache.clear();
}

/** Entries currently held — for diagnostics and tests. */
export function searchCacheSize(): number {
  return cache.size();
}
