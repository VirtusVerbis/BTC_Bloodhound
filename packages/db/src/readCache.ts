import type { Address } from "./schema.js";

export const FLAGGED_HACKERS_CACHE_DEFAULT_TTL_SEC = 120;
export const SYNC_SNAPSHOT_DEFAULT_TTL_SEC = 60;

export function pollDueCacheTtlSec(downstreamPollIntervalSec: number): number {
  return Math.max(0, downstreamPollIntervalSec);
}

export function syncSnapshotCacheTtlSec(downstreamPollIntervalSec: number): number {
  return pollDueCacheTtlSec(downstreamPollIntervalSec);
}

export function resolveSyncSnapshotMaxAgeSec(
  params: SyncSnapshotParams,
  overrideSec?: number | null,
): number {
  if (overrideSec != null && Number.isFinite(overrideSec) && overrideSec >= 0) {
    return Math.floor(overrideSec);
  }
  return syncSnapshotCacheTtlSec(params.downstreamPollIntervalSec);
}

export type SchedulerMonitorCache = {
  downstreamPollDueCount?: number;
  downstreamPollDueAt?: string | null;
  downstreamPollMaxDepth?: number;
  downstreamPollIntervalSec?: number;
  downstreamPollMinExpandSats?: number;
  downstreamTreeCount?: number;
  downstreamTreeMaxDepth?: number;
  monitorSnapshotDirty?: number;
};

/** Read cached tree/poll-due monitor stats from scheduler_state when fresh. */
export function monitorStatsFromSchedulerCache(
  state: SchedulerMonitorCache | null | undefined,
  maxDepth: number,
  minIntervalSec: number,
  minExpandSats: number,
): SyncSnapshotMonitor | null {
  if (!state) return null;
  const depth = Math.floor(maxDepth);
  const intervalSec = Math.floor(minIntervalSec);
  const floor = Math.max(0, Math.floor(minExpandSats));
  if (state.downstreamTreeMaxDepth !== depth) return null;
  const ttlSec = pollDueCacheTtlSec(intervalSec);
  const paramsMatch =
    state.downstreamPollMaxDepth === depth &&
    state.downstreamPollIntervalSec === intervalSec &&
    state.downstreamPollMinExpandSats === floor;
  const cacheFresh =
    paramsMatch &&
    isCacheFresh(state.downstreamPollDueAt, ttlSec) &&
    (state.monitorSnapshotDirty ?? 0) === 0;
  if (!cacheFresh) return null;
  return {
    treeNodeCount: state.downstreamTreeCount ?? 0,
    downstreamPollDueCount: state.downstreamPollDueCount ?? 0,
  };
}

export type SyncSnapshotParams = {
  maxCrawlDepth: number;
  downstreamPollIntervalSec: number;
  minExpandSats?: number;
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

export type HackStatsRow = {
  id: string;
  victimCount: number;
  hackerCount: number;
  totalInSats: number;
};

export const HACK_STAT_IDS = ["coldcard", "liquid"] as const;

const HACK_STAT_LABELS: Record<string, string> = { coldcard: "Coldcard", liquid: "Liquid" };

export function labeledHackStats(rows: HackStatsRow[] | undefined): Array<HackStatsRow & { label: string }> {
  const byId = new Map((rows ?? []).map((row) => [row.id, row]));
  return HACK_STAT_IDS.map((id) => {
    const row = byId.get(id) ?? { id, victimCount: 0, hackerCount: 0, totalInSats: 0 };
    return { ...row, label: HACK_STAT_LABELS[id] ?? id };
  });
}

export function serializeHackStatsRows(rows: HackStatsRow[]): string {
  return JSON.stringify(rows);
}

export function parseHackStatsJson(json: string | null | undefined): HackStatsRow[] | undefined {
  if (!json) return undefined;
  try {
    return parseHackStatsRows(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

export type SyncSnapshotStats = {
  victimCount: number;
  hackerCount: number;
  totalInSats: number;
  totalOutSats: number;
  /** Per-hack counts; omitted on pre-change snapshots (treated as a hacks cache miss). */
  hacks?: HackStatsRow[];
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
  | "hackId"
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

export function filterFlaggedHackersCache(
  rows: FlaggedHackerCacheEntry[],
  opts?: { q?: string; activeOnly?: boolean },
): FlaggedHackerCacheEntry[] {
  let out = rows;
  if (opts?.activeOnly) {
    out = out.filter((row) => row.totalReceivedSats > 0);
  }
  const q = opts?.q?.trim();
  if (!q) return out;
  const needle = q.toLowerCase();
  return out.filter((row) => {
    if (row.address.toLowerCase().includes(needle)) return true;
    if (row.label != null && row.label.toLowerCase().includes(needle)) return true;
    return false;
  });
}

export function serializeFlaggedHackersCache(rows: FlaggedHackerCacheEntry[]): string {
  return JSON.stringify(rows);
}

export function parseHackStatsRows(value: unknown): HackStatsRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map<string, HackStatsRow>();
  for (const row of value) {
    if (row == null || typeof row !== "object") return undefined;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
    if (typeof rec.victimCount !== "number" || !Number.isFinite(rec.victimCount)) return undefined;
    if (typeof rec.hackerCount !== "number" || !Number.isFinite(rec.hackerCount)) return undefined;
    if (typeof rec.totalInSats !== "number" || !Number.isFinite(rec.totalInSats)) return undefined;
    byId.set(rec.id, {
      id: rec.id,
      victimCount: rec.victimCount,
      hackerCount: rec.hackerCount,
      totalInSats: rec.totalInSats,
    });
  }
  const out: HackStatsRow[] = [];
  for (const id of HACK_STAT_IDS) {
    const row = byId.get(id);
    if (!row) return undefined;
    out.push(row);
  }
  return out;
}

export function parseSyncSnapshot(json: string | null | undefined): SyncSnapshotV1 | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as SyncSnapshotV1;
    if (parsed?.v !== 1 || typeof parsed.at !== "string") return null;
    if (!parsed.params || typeof parsed.params.maxCrawlDepth !== "number") return null;
    if (typeof parsed.params.downstreamPollIntervalSec !== "number") return null;
    if (parsed.stats && typeof parsed.stats === "object") {
      const hacks = parseHackStatsRows(parsed.stats.hacks);
      if (hacks) parsed.stats.hacks = hacks;
      else delete parsed.stats.hacks;
    }
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
