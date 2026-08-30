import type { Store } from "@cointrace/db";
import type { AppConfig } from "@cointrace/core";
import { colorizeIndexerLogLine, type IndexerLogColorMode } from "@cointrace/core";

function emitSidecarLog(
  fn: (message: string) => void,
  message: string,
  color: boolean,
  mode: IndexerLogColorMode,
): void {
  fn(colorizeIndexerLogLine(message, color, mode));
}

export function logSidecar(message: string, color: boolean, mode: IndexerLogColorMode): void {
  emitSidecarLog(console.log, message, color, mode);
}

export function logSidecarError(message: string, color: boolean, mode: IndexerLogColorMode): void {
  emitSidecarLog(console.error, message, color, mode);
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

function resolveApiBackoff(state: {
  esploraRetryAfterAt?: string | null;
  mempoolRetryAfterAt?: string | null;
} | null | undefined): string {
  const now = Date.now();
  const esplora = state?.esploraRetryAfterAt;
  const mempool = state?.mempoolRetryAfterAt;
  if (esplora && new Date(esplora).getTime() > now) return "esplora";
  if (mempool && new Date(mempool).getTime() > now) return "mempool";
  return "none";
}

export async function formatSidecarHeartbeat(
  store: Store,
  jobsSinceStart: number,
  elapsedMs: number,
): Promise<string> {
  const queue = await store.getQueueDepth();
  const summary = await store.getActiveJobSummary({ statuses: ["pending", "running"] });
  let pending = 0;
  let running = 0;
  for (const row of summary) {
    if (row.status === "pending") pending += row.count;
    if (row.status === "running") running += row.count;
  }
  const state = await store.getSchedulerState();
  const apiBackoff = resolveApiBackoff(state);
  return `[sidecar] heartbeat queue=${queue} pending=${pending} running=${running} apiBackoff=${apiBackoff} jobsSinceStart=${jobsSinceStart} elapsed=${formatElapsed(elapsedMs)}`;
}

export async function emitSidecarHeartbeat(
  store: Store,
  jobsSinceStart: number,
  elapsedMs: number,
  color: boolean,
  mode: IndexerLogColorMode,
): Promise<void> {
  const line = await formatSidecarHeartbeat(store, jobsSinceStart, elapsedMs);
  logSidecar(line, color, mode);
}

export function formatCronStatusSummary(opts: {
  cronIndexerPaused: boolean;
  tickLeaseUntil: string | null;
  queueDepth: number;
  pending: number;
  running: number;
  apiBackoff: string;
}): string {
  const lease = opts.tickLeaseUntil ?? "null";
  return `cron_indexer_paused=${opts.cronIndexerPaused ? 1 : 0} tick_lease_until=${lease} queue=${opts.queueDepth} pending=${opts.pending} running=${opts.running} apiBackoff=${opts.apiBackoff}`;
}

export async function readCronStatusFromStore(store: Store): Promise<{
  cronIndexerPaused: boolean;
  tickLeaseUntil: string | null;
  queueDepth: number;
  pending: number;
  running: number;
  apiBackoff: string;
}> {
  const state = await store.getSchedulerState();
  const queueDepth = await store.getQueueDepth();
  const summary = await store.getActiveJobSummary({ statuses: ["pending", "running"] });
  let pending = 0;
  let running = 0;
  for (const row of summary) {
    if (row.status === "pending") pending += row.count;
    if (row.status === "running") running += row.count;
  }
  return {
    cronIndexerPaused: await store.isCronIndexerPaused(),
    tickLeaseUntil: state?.tickLeaseUntil ?? null,
    queueDepth,
    pending,
    running,
    apiBackoff: resolveApiBackoff(state),
  };
}

export function logSidecarStartup(
  config: AppConfig,
  cronIndexerPaused: boolean,
  color: boolean,
  mode: IndexerLogColorMode,
): void {
  logSidecar("[sidecar] remote D1 connected", color, mode);
  logSidecar(
    `[sidecar] config cron_indexer_paused=${cronIndexerPaused ? 1 : 0} RATE_LIMIT_MS=${config.rateLimitMs} MAX_CHAIN_CALLS_PER_JOB=${config.maxChainCallsPerJob} TICK_BUDGET_MS=${config.tickBudgetMs}`,
    color,
    mode,
  );
}
