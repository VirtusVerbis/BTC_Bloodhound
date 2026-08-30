import type { AppConfig } from "@cointrace/core";
import {
  ChainRouter,
  runIndexerTick,
  setIndexerLogColorMode,
  TICK_LEASE_SKEW_MS,
} from "@cointrace/core";
import type { Store } from "@cointrace/db";
import { openRemoteProductionStore } from "./remotePlatform.js";
import {
  emitSidecarHeartbeat,
  logSidecar,
  logSidecarError,
  logSidecarStartup,
} from "./sidecarLog.js";

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
  let remoteHandle: Awaited<ReturnType<typeof openRemoteProductionStore>> | null = null;
  let store: Store | null = null;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logSidecar(`[sidecar] ${signal}`, logColor, logColorMode);
    if (store) {
      await store.clearTickLease();
      logSidecar("[sidecar] tick lease cleared", logColor, logColorMode);
    }
    if (remoteHandle) {
      await remoteHandle.dispose();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });

  try {
    remoteHandle = await openRemoteProductionStore(config);
    store = remoteHandle.store;

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

    const router = openSidecarChainRouter(store, config);
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
      emitSidecarHeartbeat(store, jobsSinceStart, Date.now() - startTime, logColor, logColorMode).catch((err) => {
        logSidecarError(
          `[sidecar] error heartbeat=${err instanceof Error ? err.message : String(err)}`,
          logColor,
          logColorMode,
        );
      });
    }, heartbeatMs);

    let lastCron = 0;
    while (!shuttingDown) {
      const leaseMs = config.tickBudgetMs + TICK_LEASE_SKEW_MS;
      const acquired = await store.tryAcquireTickLease(leaseMs);
      if (!acquired) {
        await new Promise((r) => setTimeout(r, 1000));
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
        if (jobsProcessed === 0) await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        logSidecarError(
          `[sidecar] error tick=${err instanceof Error ? err.message : String(err)}`,
          logColor,
          logColorMode,
        );
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
      } finally {
        await store.clearTickLease();
      }
    }
  } catch (err) {
    logSidecarError(`[sidecar] error ${err instanceof Error ? err.message : String(err)}`, logColor, logColorMode);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    if (remoteHandle) {
      await remoteHandle.dispose();
    }
    process.exit(1);
  }
}
