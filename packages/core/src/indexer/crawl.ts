import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import { buildBackfillJobPayload } from "./processor.js";
import { isRebuildActive } from "./rebuildMode.js";

const BACKFILL_DEDUPE_TYPES = ["backfill_hacker_address", "audit_hacker_backfill"] as const;

async function enqueueBackfillResume(store: Store, address: string): Promise<void> {
  await store.enqueueJobIfAbsent(
    "backfill_hacker_address",
    await buildBackfillJobPayload(store, address),
    JOB_PRIORITY.BACKFILL_HACKER,
    undefined,
    { dedupeTypes: [...BACKFILL_DEDUPE_TYPES], address },
  );
}

export async function maintainOneHacker(
  store: Store,
  config: AppConfig,
  h: { address: string; liveBalanceAt?: string | null },
  ts: number,
): Promise<void> {
  const address = h.address;

  const addr = await store.getAddress(address);
  const status = addr?.expandStatus ?? "pending";
  const backfill = await store.getBackfillState(address);

  if (status === "pending" || status === "backfilling") {
    await enqueueBackfillResume(store, address);
  } else if (status === "expanded" && !backfill?.backfillComplete) {
    await enqueueBackfillResume(store, address);
  } else if (status === "expanded" && backfill?.backfillComplete) {
    const lastAudit = backfill.lastBackfillAuditAt
      ? new Date(backfill.lastBackfillAuditAt).getTime()
      : 0;
    if (ts - lastAudit >= config.backfillHealAuditIntervalSec * 1000) {
      await store.enqueueJobIfAbsent(
        "audit_hacker_backfill",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { dedupeTypes: [...BACKFILL_DEDUPE_TYPES], address },
      );
    }
  }

  const balanceAt = h.liveBalanceAt ? new Date(h.liveBalanceAt).getTime() : 0;
  if (ts - balanceAt >= config.balanceRefreshIntervalSec * 1000) {
    await store.enqueueJobIfAbsent(
      "refresh_live_balance",
      { address },
      JOB_PRIORITY.REFRESH_BALANCE,
      undefined,
      { address },
    );
  }

  const backfillState = await store.getBackfillState(address);
  if (backfillState?.backfillComplete) {
    const sync = await store.getSyncState(address);
    const lastPoll = sync?.lastPolledAt ? new Date(sync.lastPolledAt).getTime() : 0;
    if (ts - lastPoll >= config.cronIntervalSec * 1000) {
      await store.enqueueJobIfAbsent(
        "poll_hacker_address",
        { address },
        JOB_PRIORITY.POLL_HACKER,
        undefined,
        { address },
      );
    }
  }
}

export async function scheduleBtcUsdPriceRefresh(store: Store, config: AppConfig): Promise<void> {
  const ts = Date.now();
  const price = await store.getBtcUsdPrice();
  const lastAt = price?.at ? new Date(price.at).getTime() : 0;
  if (ts - lastAt < config.btcUsdPriceRefreshIntervalSec * 1000) return;
  await store.enqueueJobIfAbsent("refresh_btc_usd_price", {}, JOB_PRIORITY.REFRESH_BTC_USD);
}

export async function scheduleDownstreamCrawl(store: Store, config: AppConfig): Promise<void> {
  if (await isRebuildActive(store, config)) return;

  const ts = Date.now();

  const cwSync = await store.getSourceSync("coldcardwatch");
  const cwLast = cwSync?.lastSyncAt ? new Date(cwSync.lastSyncAt).getTime() : 0;
  if (ts - cwLast >= config.coldcardwatchSyncIntervalSec * 1000) {
    await store.enqueueJobIfAbsent("sync_coldcardwatch", {}, JOB_PRIORITY.SYNC_COLDCARDWATCH);
  }

  const htSync = await store.getSourceSync("coldcard_hack_tracker");
  const swSync = await store.getSourceSync("coldcard_sweep_watch");
  const htLast = htSync?.lastSyncAt ? new Date(htSync.lastSyncAt).getTime() : 0;
  const swLast = swSync?.lastSyncAt ? new Date(swSync.lastSyncAt).getTime() : 0;
  const vtLast = Math.max(htLast, swLast);
  if (ts - vtLast >= config.vercelTrackersSyncIntervalSec * 1000) {
    await store.enqueueJobIfAbsent("sync_vercel_trackers", {}, JOB_PRIORITY.SYNC_VERCEL_TRACKERS);
  }

  const tick = await store.incrementMaintenanceCronCounter();
  if (tick % config.hackerMaintenanceEveryNCrons === 0) {
    const hackers = await store.listHackers();
    if (hackers.length > 0) {
      const idx = await store.claimNextHackerPollIndex(hackers.length);
      await maintainOneHacker(store, config, hackers[idx]!, ts);
    }
  }

  const frontier = await store.getDownstreamFrontier(config.crawlEnqueuePerCron, config.maxCrawlDepth);
  for (const row of frontier) {
    const jobId = await store.enqueueJobIfAbsent(
      "expand_downstream",
      { address: row.address, cron: true },
      JOB_PRIORITY.CRON_EXPAND,
      undefined,
      { address: row.address },
    );
    if (jobId != null) {
      await store.setExpandStatus(row.address, "queued");
    }
  }

  const pollCandidates = await store.listDownstreamForPoll(
    config.downstreamPollEnqueuePerCron,
    config.maxCrawlDepth,
    config.downstreamPollIntervalSec,
  );
  for (const row of pollCandidates) {
    await store.enqueueJobIfAbsent(
      "poll_downstream_address",
      { address: row.address },
      JOB_PRIORITY.POLL_DOWNSTREAM,
      undefined,
      { address: row.address },
    );
  }
}
