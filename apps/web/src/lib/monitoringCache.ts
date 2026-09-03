import type {
  ChainApiStatus,
  MonitoringSyncSource,
  MonitoringSyncStatus,
} from "../components/MonitoringIndicator";
import type { QuotaUsageDisplay } from "./quotaFormat";

export const MONITORING_CACHE_KEY = "cointrace:monitoring-snapshot:v1";

export type MonitoringD1Quota = QuotaUsageDisplay & {
  blocked?: boolean;
};

export type MonitoringSnapshot = {
  savedAt: string;
  monitoringActive?: boolean;
  lastActivityAt?: string | null;
  lastChainApiAt?: string | null;
  lastExternalSyncAt?: string | null;
  lastJobAt?: string | null;
  lastCompletedJobType?: string | null;
  lastCompletedJobDurationMs?: number | null;
  lastCompletedJobAt?: string | null;
  externalSources?: MonitoringSyncSource[];
  chainApis?: ChainApiStatus[];
  queueSchedulingPaused?: boolean;
  maxQueueDepth?: number;
  d1Quota?: MonitoringD1Quota;
};

export type AboutMonitoringInput = MonitoringSyncStatus & {
  d1Quota?: MonitoringD1Quota;
};

export type AboutMonitoringMerge = {
  data: MonitoringSnapshot | null;
  source: "live" | "cached";
  retrievedAt: string | null;
};

function hasQuotaUsage(d1Quota?: MonitoringD1Quota | null): boolean {
  if (!d1Quota) return false;
  return d1Quota.rowsRead > 0 || d1Quota.rowsWritten > 0 || d1Quota.workersRequests > 0;
}

export function hasMeaningfulMonitoring(sync: AboutMonitoringInput | null | undefined): boolean {
  if (!sync) return false;
  if (sync.lastActivityAt) return true;
  if (sync.externalSources && sync.externalSources.length > 0) return true;
  return hasQuotaUsage(sync.d1Quota);
}

function pickD1Quota(d1Quota?: MonitoringD1Quota): MonitoringD1Quota | undefined {
  if (!d1Quota) return undefined;
  if (
    d1Quota.rowsReadLimit == null ||
    d1Quota.rowsWrittenLimit == null ||
    d1Quota.workersRequestsLimit == null
  ) {
    return undefined;
  }
  return {
    blocked: d1Quota.blocked,
    rowsRead: d1Quota.rowsRead ?? 0,
    rowsWritten: d1Quota.rowsWritten ?? 0,
    workersRequests: d1Quota.workersRequests ?? 0,
    rowsReadLimit: d1Quota.rowsReadLimit,
    rowsWrittenLimit: d1Quota.rowsWrittenLimit,
    workersRequestsLimit: d1Quota.workersRequestsLimit,
  };
}

export function extractMonitoringSnapshot(
  sync: AboutMonitoringInput,
  savedAt = new Date().toISOString(),
): MonitoringSnapshot {
  return {
    savedAt,
    monitoringActive: sync.monitoringActive,
    lastActivityAt: sync.lastActivityAt ?? null,
    lastChainApiAt: sync.lastChainApiAt ?? null,
    lastExternalSyncAt: sync.lastExternalSyncAt ?? null,
    lastJobAt: sync.lastJobAt ?? null,
    lastCompletedJobType: sync.lastCompletedJobType ?? null,
    lastCompletedJobDurationMs: sync.lastCompletedJobDurationMs ?? null,
    lastCompletedJobAt: sync.lastCompletedJobAt ?? null,
    externalSources: sync.externalSources ? [...sync.externalSources] : undefined,
    chainApis: sync.chainApis ? sync.chainApis.map((api) => ({ ...api })) : undefined,
    queueSchedulingPaused: sync.queueSchedulingPaused,
    maxQueueDepth: sync.maxQueueDepth,
    d1Quota: pickD1Quota(sync.d1Quota),
  };
}

function liveToSnapshot(sync: AboutMonitoringInput): MonitoringSnapshot {
  return extractMonitoringSnapshot(sync, new Date().toISOString());
}

function isValidSnapshot(value: unknown): value is MonitoringSnapshot {
  if (!value || typeof value !== "object") return false;
  const snap = value as MonitoringSnapshot;
  return typeof snap.savedAt === "string" && snap.savedAt.length > 0;
}

export function saveMonitoringCache(snapshot: MonitoringSnapshot): void {
  try {
    localStorage.setItem(MONITORING_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* private browsing / quota exceeded */
  }
}

export function loadMonitoringCache(): MonitoringSnapshot | null {
  try {
    const raw = localStorage.getItem(MONITORING_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSnapshot(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function mergeMonitoringForAbout(
  live: AboutMonitoringInput | null | undefined,
  cached: MonitoringSnapshot | null | undefined,
): AboutMonitoringMerge {
  if (hasMeaningfulMonitoring(live)) {
    return {
      data: liveToSnapshot(live!),
      source: "live",
      retrievedAt: null,
    };
  }
  if (cached && hasMeaningfulMonitoring(cached)) {
    return {
      data: cached,
      source: "cached",
      retrievedAt: cached.savedAt,
    };
  }
  return { data: null, source: "cached", retrievedAt: null };
}

export type D1QuotaCacheDetail = QuotaUsageDisplay & {
  blocked?: boolean;
};

/** Merge D1 quota from a 503 event into the existing cache (or create a quota-only snapshot). */
export function saveMonitoringCacheFromD1Quota(detail: D1QuotaCacheDetail): void {
  if (
    detail.rowsReadLimit == null ||
    detail.rowsWrittenLimit == null ||
    detail.workersRequestsLimit == null
  ) {
    return;
  }

  const d1Quota: MonitoringD1Quota = {
    blocked: detail.blocked ?? true,
    rowsRead: detail.rowsRead ?? 0,
    rowsWritten: detail.rowsWritten ?? 0,
    workersRequests: detail.workersRequests ?? 0,
    rowsReadLimit: detail.rowsReadLimit,
    rowsWrittenLimit: detail.rowsWrittenLimit,
    workersRequestsLimit: detail.workersRequestsLimit,
  };

  if (!hasQuotaUsage(d1Quota) && !d1Quota.blocked) return;

  const savedAt = new Date().toISOString();
  const existing = loadMonitoringCache();
  if (existing) {
    saveMonitoringCache({ ...existing, savedAt, d1Quota });
    return;
  }

  saveMonitoringCache({
    savedAt,
    lastActivityAt: null,
    lastChainApiAt: null,
    lastExternalSyncAt: null,
    lastJobAt: null,
    lastCompletedJobType: null,
    lastCompletedJobDurationMs: null,
    lastCompletedJobAt: null,
    d1Quota,
  });
}
