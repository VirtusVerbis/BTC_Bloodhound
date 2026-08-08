/** In-memory LRU cache for /api/graph responses (keyed by query params). */

const MAX_ENTRIES = 20;

interface CacheEntry<T> {
  fetchedAt: number;
  response: T;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function fetchGraphDeduped<T>(
  key: string,
  fetchFn: () => Promise<T>,
  opts?: { force?: boolean },
): Promise<T> {
  if (!opts?.force) {
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const promise = fetchFn().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  if (!opts?.force) inflight.set(key, promise);
  return promise;
}

export function clearInflightGraph(key: string): void {
  inflight.delete(key);
}

export function graphCacheKey(parts: {
  hacker: string;
  victimSearch: string | null;
  minEdgeSats: number;
  maxVictimNodes: number;
  maxDownstreamNodes: number;
  expandVictims: boolean;
}): string {
  const victim = parts.victimSearch?.trim() || "";
  const hacker = victim ? "" : parts.hacker;
  const expand = victim ? "0" : parts.expandVictims ? "1" : "0";
  return [
    hacker,
    victim,
    String(parts.minEdgeSats),
    String(parts.maxVictimNodes),
    String(parts.maxDownstreamNodes),
    expand,
  ].join("|");
}

export function getCachedGraph<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  store.delete(key);
  store.set(key, entry);
  return entry.response as T;
}

export function setCachedGraph<T>(key: string, response: T): void {
  if (store.has(key)) store.delete(key);
  store.set(key, { fetchedAt: Date.now(), response });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function invalidateCachedGraph(key: string): void {
  store.delete(key);
}
