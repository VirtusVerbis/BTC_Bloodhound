import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AppConfig } from "@cointrace/core";
import {
  ChainRouter,
  clearTickLeaseSafe,
  formatErrorMessage,
  runIndexerTick,
  setIndexerLogColorMode,
  TICK_LEASE_SKEW_MS,
  type IndexerLogColorMode,
} from "@cointrace/core";
import type { D1RowMeter, Store } from "@cointrace/db";
import {
  openRemoteProductionStore,
  reconnectRemoteProductionStore,
  type RemoteProductionStore,
} from "./remotePlatform.js";
import { ReconnectCoordinator } from "./remoteReconnect.js";
import {
  createDebouncedMeterFlush,
  defaultSidecarD1MeterPath,
  flushSidecarD1Meter,
  loadSidecarD1Meter,
} from "./sidecarD1MeterStore.js";
import {
  parseSidecarD1QuotaLimits,
  promptContinueOnWriteQuota,
  shouldWarnWrites,
} from "./sidecarD1Quota.js";
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
const TICK_WATCHDOG_EXTRA_MS = 30_000;

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

type TickRaceResult =
  | { ok: true; jobsProcessed: number }
  | { ok: false; watchdog: true };

async function runIndexerTickWithWatchdog(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  opts: {
    schedule: boolean;
    jobDetails: boolean;
    logColor: boolean;
    logColorMode?: IndexerLogColorMode;
  },
  watchdogMs: number,
): Promise<TickRaceResult> {
  const tickPromise = runIndexerTick(store, router, config, opts).then((result) => ({
    ok: true as const,
    jobsProcessed: result.jobsProcessed,
  }));
  const watchdogPromise = sleep(watchdogMs).then(() => ({ ok: false as const, watchdog: true as const }));
  return Promise.race([tickPromise, watchdogPromise]);
}

export async function runRemoteSidecar(config: AppConfig, argv: string[]): Promise<void> {
  const allowCronActive = argv.includes("--allow-cron-active");
  const jobDetails = !argv.includes("--no-job-details");
  const logColor = !argv.includes("--no-log-color");
  const logColorMode = config.indexerLogColorMode;
  const quotaLimits = parseSidecarD1QuotaLimits();
  const meterPath = defaultSidecarD1MeterPath();

  if (logColor) {
    setIndexerLogColorMode(logColorMode);
  }

  const loaded = loadSidecarD1Meter(meterPath);
  const d1RowMeter: D1RowMeter = loaded.meter;
  if (loaded.warning) {
    logSidecarError(`[sidecar] D1 meter: ${loaded.warning}`, logColor, logColorMode);
  } else if (!loaded.loadedFromFile) {
    logSidecar("[sidecar] D1 meter: starting fresh for today UTC", logColor, logColorMode);
  }

  const meterFlush = createDebouncedMeterFlush(d1RowMeter, meterPath);
  d1RowMeter.onRecord(() => meterFlush.flush());
  d1RowMeter.onRollover(() => {
    meterFlush.flushNow();
    writeQuotaAcknowledged = false;
    logSidecar("[sidecar] UTC day rollover — D1 meter counters reset", logColor, logColorMode);
  });

  let writeQuotaAcknowledged = false;
  let shuttingDown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let remoteHandle: RemoteProductionStore | null = null;
  let store: Store | null = null;
  let router: ChainRouter | null = null;
  let reconnectBackoffMs = RECONNECT_BACKOFF_INITIAL_MS;
  let reconnectInFlight: Promise<void> | null = null;
  const remoteOpts = { d1RowMeter };

  const reconnectCoord = new ReconnectCoordinator({
    onDeferred: () => logSidecar("[sidecar] reconnect deferred (tick in progress)", logColor, logColorMode),
  });

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
    const tickAbandoned = reconnectCoord.consumeTickAbandoned();
    reconnectInFlight = (async () => {
      try {
        remoteHandle = await reconnectRemoteProductionStore(config, remoteHandle, remoteOpts);
        store = remoteHandle.store;
        router = openSidecarChainRouter(store, config);
        reconnectBackoffMs = RECONNECT_BACKOFF_INITIAL_MS;
        logSidecar("[sidecar] remote D1 reconnected", logColor, logColorMode);
        if (tickAbandoned) {
          const { reclaimed } = await store.resetRunningJobs(0);
          if (reclaimed > 0) {
            logSidecar(
              `Reclaimed ${reclaimed} orphaned running job(s) after tick watchdog`,
              logColor,
              logColorMode,
            );
          }
        }
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

  const requestReconnect = async (err: unknown): Promise<void> => {
    if (reconnectCoord.requestReconnect(err)) {
      await reconnectRemoteStore();
    }
  };

  const flushReconnectIfPending = async (): Promise<void> => {
    if (reconnectCoord.consumePendingReconnect()) {
      await reconnectRemoteStore();
    }
  };

  let lastRemoteQuotaFlush = { rowsRead: 0, rowsWritten: 0 };
  const flushSidecarQuotaToRemote = async (targetStore: Store): Promise<void> => {
    d1RowMeter.rolloverIfNeeded();
    const snap = d1RowMeter.snapshot();
    const reads = snap.rowsRead - lastRemoteQuotaFlush.rowsRead;
    const writes = snap.rowsWritten - lastRemoteQuotaFlush.rowsWritten;
    if (reads === 0 && writes === 0) return;
    await targetStore.flushQuotaUsage("api", { reads, writes, requests: 0 });
    lastRemoteQuotaFlush = { rowsRead: snap.rowsRead, rowsWritten: snap.rowsWritten };
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
    flushSidecarD1Meter(d1RowMeter, meterPath);
    if (store) {
      try {
        await flushSidecarQuotaToRemote(store);
      } catch (err) {
        logSidecarErrorFrom("[sidecar] error flushRemoteQuota=", err, logColor, logColorMode);
      }
    }
    meterFlush.dispose();
    if (remoteHandle) {
      await remoteHandle.dispose();
    }
    process.exit(0);
  };

  const ensureWriteQuotaAllowed = async (): Promise<boolean> => {
    const rolled = d1RowMeter.rolloverIfNeeded();
    if (rolled) {
      meterFlush.flushNow();
      writeQuotaAcknowledged = false;
    }
    if (!shouldWarnWrites(d1RowMeter, quotaLimits.writeDailyLimit, quotaLimits.writeWarnPct)) {
      return true;
    }
    if (writeQuotaAcknowledged) return true;

    const rl = readline.createInterface({ input, output });
    try {
      const continueRun = await promptContinueOnWriteQuota({
        meter: d1RowMeter,
        limits: quotaLimits,
        ask: (q) => rl.question(q),
        isTty: Boolean(input.isTTY),
        log: (msg) => logSidecar(msg, logColor, logColorMode),
        logWarn: (msg) => logSidecarError(msg, logColor, logColorMode),
      });
      if (!continueRun) {
        await shutdown("D1_WRITE_QUOTA_DECLINED");
        return false;
      }
      writeQuotaAcknowledged = true;
      return true;
    } finally {
      rl.close();
    }
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
    remoteHandle = await openRemoteProductionStore(config, remoteOpts);
    store = remoteHandle.store;
    router = openSidecarChainRouter(store, config);

    const paused = await store.isCronIndexerPaused();
    if (!paused && !allowCronActive) {
      logSidecarError(
        "[sidecar] error cron not paused — run pause-cron --remote first (or pass --allow-cron-active)",
        logColor,
        logColorMode,
      );
      meterFlush.dispose();
      await remoteHandle.dispose();
      remoteHandle = null;
      process.exit(1);
    }

    logSidecarStartup(config, paused, logColor, logColorMode, d1RowMeter, quotaLimits);
    flushSidecarD1Meter(d1RowMeter, meterPath);

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
    const tickWatchdogMs = config.tickBudgetMs + TICK_LEASE_SKEW_MS + TICK_WATCHDOG_EXTRA_MS;

    heartbeatTimer = setInterval(() => {
      if (!store || reconnectCoord.tickInProgress) return;
      emitSidecarHeartbeat(
        store,
        jobsSinceStart,
        Date.now() - startTime,
        logColor,
        logColorMode,
        d1RowMeter,
        quotaLimits,
      )
        .then(async () => {
          meterFlush.flushNow();
          if (store) {
            await flushSidecarQuotaToRemote(store);
          }
        })
        .catch((err) => {
          logSidecarErrorFrom("[sidecar] error heartbeat=", err, logColor, logColorMode);
          void requestReconnect(err);
        });
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
        await requestReconnect(err);
        await sleep(LOOP_SLEEP_MS);
        continue;
      }

      if (!acquired) {
        await sleep(LOOP_SLEEP_MS);
        continue;
      }

      if (!(await ensureWriteQuotaAllowed())) {
        break;
      }

      reconnectCoord.tickInProgress = true;
      try {
        const now = Date.now();
        const due = now - lastCron >= config.cronIntervalSec * 1000;
        const tickResult = await runIndexerTickWithWatchdog(
          store,
          router,
          config,
          { schedule: due, jobDetails, logColor, logColorMode },
          tickWatchdogMs,
        );

        if (!tickResult.ok) {
          logSidecar(
            `[sidecar] tick watchdog exceeded ms=${tickWatchdogMs}`,
            logColor,
            logColorMode,
          );
          reconnectCoord.markTickAbandoned();
        } else {
          jobsSinceStart += tickResult.jobsProcessed;
          if (due) lastCron = now;
          if (tickResult.jobsProcessed === 0) await sleep(LOOP_SLEEP_MS);
        }
      } catch (err) {
        logSidecarErrorFrom("[sidecar] error tick=", err, logColor, logColorMode);
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        reconnectCoord.requestReconnect(err);
      } finally {
        reconnectCoord.tickInProgress = false;
        await flushReconnectIfPending();
        await clearLeaseSafe(store);
        meterFlush.flush();
        try {
          await flushSidecarQuotaToRemote(store);
        } catch (err) {
          logSidecarErrorFrom("[sidecar] error flushRemoteQuota=", err, logColor, logColorMode);
        }
      }
    }
  } catch (err) {
    logSidecarErrorFrom("[sidecar] error ", err, logColor, logColorMode);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    meterFlush.dispose();
    if (remoteHandle) {
      await remoteHandle.dispose();
    }
    process.exit(1);
  }
}
