import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import { buildBackfillJobPayload } from "./processor.js";
import { isRebuildActive } from "./rebuildMode.js";

async function enqueueBackfillResume(store: Store, address: string): Promise<void> {
  await store.enqueueJob(
    "backfill_hacker_address",
    await buildBackfillJobPayload(store, address),
    JOB_PRIORITY.BACKFILL_HACKER,
  );
}

export async function scheduleHackerBackfillHeal(store: Store, config: AppConfig): Promise<void> {
  const ts = Date.now();
  const hackers = await store.listHackers();
  if (hackers.length === 0) return;

  for (const h of hackers) {
    if (await store.hasPendingJob("backfill_hacker_address", h.address)) continue;
    if (await store.hasPendingJob("audit_hacker_backfill", h.address)) continue;

    const addr = await store.getAddress(h.address);
    const status = addr?.expandStatus ?? "pending";
    const backfill = await store.getBackfillState(h.address);

    if (status === "pending" || status === "backfilling") {
      await enqueueBackfillResume(store, h.address);
      continue;
    }

    if (status === "expanded" && !backfill?.backfillComplete) {
      await enqueueBackfillResume(store, h.address);
    }
  }

  let auditsEnqueued = 0;
  let idx = (await store.getBackfillHealAuditIndex()) % hackers.length;
  let scanned = 0;

  while (auditsEnqueued < config.backfillHealAuditPerCron && scanned < hackers.length) {
    const h = hackers[idx]!;
    idx = (idx + 1) % hackers.length;
    scanned++;

    if (await store.hasPendingJob("backfill_hacker_address", h.address)) continue;
    if (await store.hasPendingJob("audit_hacker_backfill", h.address)) continue;

    const addr = await store.getAddress(h.address);
    if (addr?.expandStatus !== "expanded") continue;

    const backfill = await store.getBackfillState(h.address);
    if (!backfill?.backfillComplete) continue;

    const lastAudit = backfill.lastBackfillAuditAt
      ? new Date(backfill.lastBackfillAuditAt).getTime()
      : 0;
    if (ts - lastAudit < config.backfillHealAuditIntervalSec * 1000) continue;

    await store.enqueueJob("audit_hacker_backfill", { address: h.address }, JOB_PRIORITY.BACKFILL_HACKER);
    auditsEnqueued++;
  }

  await store.setBackfillHealAuditIndex(idx);
}

export async function scheduleBtcUsdPriceRefresh(store: Store, config: AppConfig): Promise<void> {
  const ts = Date.now();
  const price = await store.getBtcUsdPrice();
  const lastAt = price?.at ? new Date(price.at).getTime() : 0;
  if (ts - lastAt < config.btcUsdPriceRefreshIntervalSec * 1000) return;
  if (await store.hasPendingJob("refresh_btc_usd_price")) return;
  await store.enqueueJob("refresh_btc_usd_price", {}, JOB_PRIORITY.REFRESH_BTC_USD);
}

export async function scheduleDownstreamCrawl(store: Store, config: AppConfig): Promise<void> {
  if (await isRebuildActive(store, config)) return;

  const ts = Date.now();

  const cwSync = await store.getSourceSync("coldcardwatch");
  const cwLast = cwSync?.lastSyncAt ? new Date(cwSync.lastSyncAt).getTime() : 0;
  if (ts - cwLast >= config.coldcardwatchSyncIntervalSec * 1000) {
    if (!(await store.hasPendingJob("sync_coldcardwatch"))) {
      await store.enqueueJob("sync_coldcardwatch", {}, JOB_PRIORITY.SYNC_COLDCARDWATCH);
    }
  }

  const htSync = await store.getSourceSync("coldcard_hack_tracker");
  const swSync = await store.getSourceSync("coldcard_sweep_watch");
  const htLast = htSync?.lastSyncAt ? new Date(htSync.lastSyncAt).getTime() : 0;
  const swLast = swSync?.lastSyncAt ? new Date(swSync.lastSyncAt).getTime() : 0;
  const vtLast = Math.max(htLast, swLast);
  if (ts - vtLast >= config.vercelTrackersSyncIntervalSec * 1000) {
    if (!(await store.hasPendingJob("sync_vercel_trackers"))) {
      await store.enqueueJob("sync_vercel_trackers", {}, JOB_PRIORITY.SYNC_VERCEL_TRACKERS);
    }
  }

  for (const h of await store.listHackers()) {
    const sync = await store.getSyncState(h.address);
    const lastPoll = sync?.lastPolledAt ? new Date(sync.lastPolledAt).getTime() : 0;
    if (ts - lastPoll >= config.cronIntervalSec * 1000 && !(await store.hasPendingJob("poll_hacker_address", h.address))) {
      await store.enqueueJob("poll_hacker_address", { address: h.address }, JOB_PRIORITY.POLL_HACKER);
    }

    const balanceAt = h.liveBalanceAt ? new Date(h.liveBalanceAt).getTime() : 0;
    if (
      ts - balanceAt >= config.balanceRefreshIntervalSec * 1000 &&
      !(await store.hasPendingJob("refresh_live_balance", h.address))
    ) {
      await store.enqueueJob("refresh_live_balance", { address: h.address }, JOB_PRIORITY.REFRESH_BALANCE);
    }
  }

  await scheduleHackerBackfillHeal(store, config);

  const frontier = await store.getDownstreamFrontier(config.crawlEnqueuePerCron, config.maxCrawlDepth);
  for (const row of frontier) {
    if (await store.hasPendingJob("expand_downstream", row.address)) continue;
    await store.setExpandStatus(row.address, "queued");
    await store.enqueueJob("expand_downstream", { address: row.address, cron: true }, JOB_PRIORITY.CRON_EXPAND);
  }

  const pollCandidates = await store.listDownstreamForPoll(
    config.downstreamPollEnqueuePerCron,
    config.maxCrawlDepth,
    config.downstreamPollIntervalSec,
  );
  for (const row of pollCandidates) {
    if (await store.hasPendingJob("poll_downstream_address", row.address)) continue;
    await store.enqueueJob("poll_downstream_address", { address: row.address }, JOB_PRIORITY.POLL_DOWNSTREAM);
  }
}
