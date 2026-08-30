import type { AppConfig } from "@cointrace/core";
import {
  ChainRouter,
  clearTickLeaseSafe,
  formatErrorMessage,
  isD1TransportError,
  runIndexerTick,
  setIndexerLogColorMode,
  TICK_LEASE_SKEW_MS,
} from "@cointrace/core";
import type { Store } from "@cointrace/db";
import {
  openRemoteProductionStore,
  reconnectRemoteProductionStore,
  type RemoteProductionStore,
} from "./remotePlatform.js";
import {
  emitSidecarHeartbeat,
  logSidecar,
  logSidecarError,
  logSidecarErrorFrom,
  logSidecarStartup,
} from "./sidecarLog.js";

const RECONNECT_BACKOFF_INITIAL_MS = 5_000;
const RECONNECT_BACKOFF_MAX_MS = 60_000;
const LOOP_SLEEP_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSidecarChainRouter(store: Store, config: AppConfig): ChainRouter {
  return new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs, {
    sleepOnRateLimit: true,
    primaryProvider: config.chainPrimaryProvider,
    backoff: {
      rateLimitMs: config.rateLimitMs,
      apiThresholdBaseSec: config.apiThresholdBaseSec,
      apiThresholdMaxSec: config.apiThresholdMaxSec,
    },
  });
}

export async function runRemoteSidecar(config: AppConfig, argv: string[]): Promise<void> {
  const allowCronActive = argv.includes("--allow-cron-active");
  const jobDetails = !argv.includes("--no-job-details");
  const logColor = !argv.includes("--no-log-color");
  const logColorMode = config.indexerLogColorMode;

  if (logColor) {
    setIndexerLogColorMode(logColorMode);
  }

  let shuttingDown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let remoteHandle: RemoteProductionStore | null = null;
  let store: Store | null = null;
  let router: ChainRouter | null = null;
  let reconnectBackoffMs = RECONNECT_BACKOFF_INITIAL_MS;
  let reconnectInFlight: Promise<void> | null = null;

  const clearLeaseSafe = async (target: Store) => {
    await clearTickLeaseSafe(target, (msg) =>
      logSidecarError(`[sidecar] clearTickLease failed: ${msg}`, logColor, logColorMode),
    );
  };

  const reconnectRemoteStore = async (): Promise<void> => {
    if (reconnectInFlight) {
      await reconnectInFlight;
      return;
    }
    reconnectInFlight = (async () => {
      try {
        remoteHandle = await reconnectRemoteProductionStore(config, remoteHandle);
        store = remoteHandle.store;
        router = openSidecarChainRouter(store, config);
        reconnectBackoffMs = RECONNECT_BACKOFF_INITIAL_MS;
        logSidecar("[sidecar] remote D1 reconnected", logColor, logColorMode);
      } catch (err) {
        logSidecarErrorFrom("[sidecar] remote D1 reconnect failed: ", err, logColor, logColorMode);
        await sleep(reconnectBackoffMs);
        reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
      } finally {
        reconnectInFlight = null;
      }
    })();
    await reconnectInFlight;
  };

  const handleTransportError = async (err: unknown): Promise<void> => {
    if (!isD1TransportError(err)) return;
    await reconnectRemoteStore();
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logSidecar(`[sidecar] ${signal}`, logColor, logColorMode);
    if (store) {
      await clearLeaseSafe(store);
      logSidecar("[sidecar] tick lease cleared", logColor, logColorMode);
    }
    if (remoteHandle) {
      await remoteHandle.dispose();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("exit:")) return;
      console.error(formatErrorMessage(err));
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("exit:")) return;
      console.error(formatErrorMessage(err));
      process.exit(1);
    });
  });

  try {
    remoteHandle = await openRemoteProductionStore(config);
    store = remoteHandle.store;
    router = openSidecarChainRouter(store, config);

    const paused = await store.isCronIndexerPaused();
    if (!paused && !allowCronActive) {
      logSidecarError(
        "[sidecar] error cron not paused — run pause-cron --remote first (or pass --allow-cron-active)",
        logColor,
        logColorMode,
      );
      await remoteHandle.dispose();
      remoteHandle = null;
      process.exit(1);
    }

    logSidecarStartup(config, paused, logColor, logColorMode);

    const { reclaimed } = await store.resetRunningJobs(config.runningJobStaleMs, {
      jobReclaimDeferAfter: config.jobReclaimDeferAfter,
      jobReclaimDeferSec: config.jobReclaimDeferSec,
    });
    if (reclaimed > 0) {
      logSidecar(`Reclaimed ${reclaimed} orphaned running job(s) to pending`, logColor, logColorMode);
    }

    let jobsSinceStart = 0;
    const startTime = Date.now();
    const heartbeatMs = config.sidecarHeartbeatSec * 1000;
    heartbeatTimer = setInterval(() => {
      if (!store) return;
      emitSidecarHeartbeat(store, jobsSinceStart, Date.now() - startTime, logColor, logColorMode).catch(
        async (err) => {
          logSidecarErrorFrom("[sidecar] error heartbeat=", err, logColor, logColorMode);
          await handleTransportError(err);
        },
      );
    }, heartbeatMs);

    let lastCron = 0;
    while (!shuttingDown) {
      if (!store || !router) {
        await sleep(LOOP_SLEEP_MS);
        continue;
      }

      const leaseMs = config.tickBudgetMs + TICK_LEASE_SKEW_MS;
      let acquired = false;
      try {
        acquired = await store.tryAcquireTickLease(leaseMs);
      } catch (err) {
        logSidecarErrorFrom("[sidecar] error acquireLease=", err, logColor, logColorMode);
        await handleTransportError(err);
        await sleep(LOOP_SLEEP_MS);
        continue;
      }

      if (!acquired) {
        await sleep(LOOP_SLEEP_MS);
        continue;
      }

      try {
        const now = Date.now();
        const due = now - lastCron >= config.cronIntervalSec * 1000;
        const { jobsProcessed } = await runIndexerTick(store, router, config, {
          schedule: due,
          jobDetails,
          logColor,
          logColorMode,
        });
        jobsSinceStart += jobsProcessed;
        if (due) lastCron = now;
        if (jobsProcessed === 0) await sleep(LOOP_SLEEP_MS);
      } catch (err) {
        logSidecarErrorFrom("[sidecar] error tick=", err, logColor, logColorMode);
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
      } finally {
        await clearLeaseSafe(store);
      }
    }
  } catch (err) {
    logSidecarErrorFrom("[sidecar] error ", err, logColor, logColorMode);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    if (remoteHandle) {
      await remoteHandle.dispose();
    }
    process.exit(1);
  }
}
