import type { Address } from "./schema.js";

export const FLAGGED_HACKERS_CACHE_DEFAULT_TTL_SEC = 120;
export const SYNC_SNAPSHOT_DEFAULT_TTL_SEC = 60;
export const POLL_DUE_CACHE_MAX_TTL_SEC = 60;

export function pollDueCacheTtlSec(downstreamPollIntervalSec: number): number {
  return Math.min(Math.max(0, downstreamPollIntervalSec), POLL_DUE_CACHE_MAX_TTL_SEC);
}

export type SyncSnapshotParams = {
  maxCrawlDepth: number;
  downstreamPollIntervalSec: number;
};

export type SyncSnapshotCrawl = {
  crawlPendingCount: number;
  crawlExpandedCount: number;
  crawlMaxHopReached: number;
};

export type SyncSnapshotMonitor = {
  treeNodeCount: number;
  downstreamPollDueCount: number;
};

export type SyncSnapshotLastCompletedJob = {
  type: string | null;
  durationMs: number | null;
  at: string | null;
};

export type SyncSnapshotStats = {
  victimCount: number;
  hackerCount: number;
  totalInSats: number;
  totalOutSats: number;
};

export type SyncSnapshotV1 = {
  v: 1;
  at: string;
  params: SyncSnapshotParams;
  crawl: SyncSnapshotCrawl;
  monitor: SyncSnapshotMonitor;
  lastCompletedJob: SyncSnapshotLastCompletedJob;
  stats: SyncSnapshotStats;
};

export type FlaggedHackerCacheEntry = Pick<
  Address,
  | "address"
  | "role"
  | "label"
  | "source"
  | "isFlaggedHacker"
  | "totalReceivedSats"
  | "liveBalanceSats"
  | "liveBalanceAt"
  | "lastGraphActivityAt"
>;

export function isCacheFresh(cacheAt: string | null | undefined, maxAgeSec: number, nowMs = Date.now()): boolean {
  if (!cacheAt) return false;
  const atMs = new Date(cacheAt).getTime();
  if (!Number.isFinite(atMs)) return false;
  return nowMs - atMs <= maxAgeSec * 1000;
}

export function parseFlaggedHackersCache(json: string | null | undefined): FlaggedHackerCacheEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is FlaggedHackerCacheEntry => {
      return row != null && typeof row === "object" && typeof (row as FlaggedHackerCacheEntry).address === "string";
    });
  } catch {
    return [];
  }
}

export function serializeFlaggedHackersCache(rows: FlaggedHackerCacheEntry[]): string {
  return JSON.stringify(rows);
}

export function parseSyncSnapshot(json: string | null | undefined): SyncSnapshotV1 | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as SyncSnapshotV1;
    if (parsed?.v !== 1 || typeof parsed.at !== "string") return null;
    if (!parsed.params || typeof parsed.params.maxCrawlDepth !== "number") return null;
    if (typeof parsed.params.downstreamPollIntervalSec !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function serializeSyncSnapshot(snapshot: SyncSnapshotV1): string {
  return JSON.stringify(snapshot);
}

export function syncSnapshotParamsMatch(
  snapshot: SyncSnapshotV1,
  params: SyncSnapshotParams,
): boolean {
  return (
    snapshot.params.maxCrawlDepth === params.maxCrawlDepth &&
    snapshot.params.downstreamPollIntervalSec === params.downstreamPollIntervalSec
  );
}
