import { api } from "./api";

export type QueueJobClass = "ingest" | "maint" | "cosmetic";

export interface QueueJobDetails {
  address?: string;
  txid?: string;
  continuation?: boolean;
  cron?: boolean;
  pendingTxidsCount?: number;
  processedIndex?: number | null;
  chainCursor?: string | null;
  pagesExhausted?: boolean | null;
  pagesFetched?: number | null;
  traceEdgeIndex?: number | null;
  traceEdgesPending?: boolean;
  payload?: unknown;
}

export interface QueueJob {
  id: number;
  type: string;
  status: string;
  priority: number;
  priorityName: string | null;
  jobClass: QueueJobClass;
  runAfter: string;
  runAfterDue: boolean;
  createdAt: string;
  startedAt: string | null;
  attempts: number;
  lastError: string | null;
  details: QueueJobDetails;
  waitSec: number;
  ageBoost: number;
  effectivePriority: number;
}

export interface QueueSnapshot {
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  context: {
    rebuildActive: boolean;
    queueDepth: number;
    crawlPendingCount: number;
    downstreamPollDueCount: number;
    queueSchedulingPaused: boolean;
  };
  jobs: QueueJob[];
  truncated: boolean;
}

export function fetchQueueSnapshot(limit = 10): Promise<QueueSnapshot> {
  return api<QueueSnapshot>(`/api/queue?limit=${limit}`);
}
