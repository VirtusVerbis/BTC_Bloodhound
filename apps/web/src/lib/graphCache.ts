/** In-memory LRU cache for /api/graph responses (keyed by query params). */

import type { ApiGraphResponse } from "./graphLoader";
import type { GraphLoadParams } from "./graphFilter";

const MAX_ENTRIES = 20;

export interface GraphL1State {
  loadId?: string;
  loadedL1: number;
  nextCursor: string | null;
  done: boolean;
}

export interface GraphL2Session {
  l2Token: string;
  loadedL2: number;
  nextCursor: string | null;
  done: boolean;
}

export interface GraphLoadState {
  response: ApiGraphResponse;
  params: GraphLoadParams;
  l1: GraphL1State;
  l2Sessions: GraphL2Session[];
}

interface CacheEntry {
  fetchedAt: number;
  state: GraphLoadState;
}

const store = new Map<string, CacheEntry>();
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

export function getCachedGraphLoadState(key: string): GraphLoadState | null {
  const entry = store.get(key);
  if (!entry) return null;
  store.delete(key);
  store.set(key, entry);
  return entry.state;
}

/** @deprecated Use getCachedGraphLoadState — returns response only for backward compat. */
export function getCachedGraph<T>(key: string): T | null {
  const state = getCachedGraphLoadState(key);
  return state ? (state.response as T) : null;
}

export function setCachedGraphLoadState(key: string, state: GraphLoadState): void {
  if (store.has(key)) store.delete(key);
  store.set(key, { fetchedAt: Date.now(), state });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function setCachedGraph<T>(key: string, response: T): void {
  setCachedGraphLoadState(key, {
    response: response as ApiGraphResponse,
    params: {
      hacker: "",
      minEdgeSats: 0,
      maxVictims: 0,
      maxDownstream: 0,
      expandVictims: false,
    },
    l1: { loadedL1: 0, nextCursor: null, done: true },
    l2Sessions: [],
  });
}

export function invalidateCachedGraph(key: string): void {
  store.delete(key);
}

/** Find any cached load state for the same hacker that can be trimmed or resumed. */
export function findRelatedGraphLoadState(
  params: GraphLoadParams,
  victimSearch: string | null,
): GraphLoadState | null {
  if (victimSearch) return null;
  for (const entry of store.values()) {
    const s = entry.state;
    if (s.params.hacker !== params.hacker) continue;
    if (s.params.expandVictims !== params.expandVictims) continue;
    return s;
  }
  return null;
}
