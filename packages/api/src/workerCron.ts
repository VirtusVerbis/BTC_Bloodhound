import { D1RowMeter } from "@cointrace/db";
import type { Store } from "@cointrace/db";
import {
  ChainRouter,
  clearTickLeaseSafe,
  formatCronPaceSkipLine,
  formatUtcResetCountdown,
  logCronDetail,
  logCronError,
  logCronException,
  runIndexerTick,
  shouldPaceCron,
  TICK_LEASE_SKEW_MS,
  type AppConfig,
} from "@cointrace/core";

export type CronMeterStart = { rowsRead: number; rowsWritten: number };

export async function flushCronQuota(
  store: Store,
  d1RowMeter: D1RowMeter,
  meterStart: CronMeterStart,
  opts?: { requests?: number },
): Promise<void> {
  d1RowMeter.rolloverIfNeeded();
  const snap = d1RowMeter.snapshot();
  await store.flushQuotaUsage("cron", {
    reads: snap.rowsRead - meterStart.rowsRead,
    writes: snap.rowsWritten - meterStart.rowsWritten,
    requests: opts?.requests ?? 1,
  });
}

function quotaLimits(config: AppConfig) {
  return {
    rowsReadLimit: config.d1ReadDailyLimit,
    rowsWrittenLimit: config.d1WriteDailyLimit,
    workersRequestsLimit: config.workersRequestDailyLimit,
  };
}

/** Cloudflare Cron scheduled handler body (meter + flush contract). */
export async function runCronScheduled(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  d1RowMeter: D1RowMeter,
): Promise<void> {
  d1RowMeter.rolloverIfNeeded();
  const meterStart = d1RowMeter.snapshot();
  let leaseAcquired = false;
  try {
    if (await store.isCronIndexerPaused()) return;

    const snapshot = await store.getQuotaSnapshot();
    const pace = shouldPaceCron(snapshot, quotaLimits(config), {
      cronUtilizationPct: config.cronQuotaUtilizationPct,
    });
    if (pace.paced) {
      logCronDetail(
        config.indexerJobDetails,
        formatCronPaceSkipLine(pace, snapshot, formatUtcResetCountdown()),
        config.indexerLogColor,
      );
      return;
    }

    const leaseMs = config.tickBudgetMs + TICK_LEASE_SKEW_MS;
    leaseAcquired = await store.tryAcquireTickLease(leaseMs);
    if (!leaseAcquired) return;

    try {
      await store.resetRunningJobs(config.runningJobStaleMs, {
        jobReclaimDeferAfter: config.jobReclaimDeferAfter,
        jobReclaimDeferSec: config.jobReclaimDeferSec,
      });
      await runIndexerTick(store, router, config, {
        schedule: true,
        jobDetails: config.indexerJobDetails,
      });
    } finally {
      if (leaseAcquired) {
        await clearTickLeaseSafe(store, (msg) =>
          logCronError(`[cron] clearTickLease failed: ${msg}`, config.indexerLogColor),
        );
      }
    }
  } catch (err) {
    logCronException("[cron] scheduled failed: ", err, config.indexerLogColor);
  } finally {
    try {
      await flushCronQuota(store, d1RowMeter, meterStart);
    } catch (err) {
      logCronException("[cron] flushQuotaUsage failed: ", err, config.indexerLogColor);
    }
  }
}
