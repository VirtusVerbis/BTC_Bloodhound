import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import { buildBackfillJobPayload } from "./processor.js";
import { isRebuildActive } from "./rebuildMode.js";

function enqueueBackfillResume(store: Store, address: string): void {
  store.enqueueJob(
    "backfill_hacker_address",
    buildBackfillJobPayload(store, address),
    JOB_PRIORITY.BACKFILL_HACKER,
  );
}

export function scheduleHackerBackfillHeal(store: Store, config: AppConfig): void {
  const ts = Date.now();
  const hackers = store.listHackers();
  if (hackers.length === 0) return;

  for (const h of hackers) {
    if (store.hasPendingJob("backfill_hacker_address", h.address)) continue;
    if (store.hasPendingJob("audit_hacker_backfill", h.address)) continue;

    const addr = store.getAddress(h.address);
    const status = addr?.expandStatus ?? "pending";
    const backfill = store.getBackfillState(h.address);

    if (status === "pending" || status === "backfilling") {
      enqueueBackfillResume(store, h.address);
      continue;
    }

    if (status === "expanded" && !backfill?.backfillComplete) {
      enqueueBackfillResume(store, h.address);
    }
  }

  let auditsEnqueued = 0;
  let idx = store.getBackfillHealAuditIndex() % hackers.length;
  let scanned = 0;

  while (auditsEnqueued < config.backfillHealAuditPerCron && scanned < hackers.length) {
    const h = hackers[idx]!;
    idx = (idx + 1) % hackers.length;
    scanned++;

    if (store.hasPendingJob("backfill_hacker_address", h.address)) continue;
    if (store.hasPendingJob("audit_hacker_backfill", h.address)) continue;

    const addr = store.getAddress(h.address);
    if (addr?.expandStatus !== "expanded") continue;

    const backfill = store.getBackfillState(h.address);
    if (!backfill?.backfillComplete) continue;

    const lastAudit = backfill.lastBackfillAuditAt
      ? new Date(backfill.lastBackfillAuditAt).getTime()
      : 0;
    if (ts - lastAudit < config.backfillHealAuditIntervalSec * 1000) continue;

    store.enqueueJob("audit_hacker_backfill", { address: h.address }, JOB_PRIORITY.BACKFILL_HACKER);
    auditsEnqueued++;
  }

  store.setBackfillHealAuditIndex(idx);
}

export function scheduleBtcUsdPriceRefresh(store: Store, config: AppConfig): void {
  const ts = Date.now();
  const price = store.getBtcUsdPrice();
  const lastAt = price?.at ? new Date(price.at).getTime() : 0;
  if (ts - lastAt < config.btcUsdPriceRefreshIntervalSec * 1000) return;
  if (store.hasPendingJob("refresh_btc_usd_price")) return;
  store.enqueueJob("refresh_btc_usd_price", {}, JOB_PRIORITY.REFRESH_BTC_USD);
}

export function scheduleDownstreamCrawl(store: Store, config: AppConfig): void {
  if (isRebuildActive(store, config)) return;

  const ts = Date.now();

  const cwSync = store.getSourceSync("coldcardwatch");
  const cwLast = cwSync?.lastSyncAt ? new Date(cwSync.lastSyncAt).getTime() : 0;
  if (ts - cwLast >= config.coldcardwatchSyncIntervalSec * 1000) {
    if (!store.hasPendingJob("sync_coldcardwatch")) {
      store.enqueueJob("sync_coldcardwatch", {}, JOB_PRIORITY.SYNC_COLDCARDWATCH);
    }
  }

  const htSync = store.getSourceSync("coldcard_hack_tracker");
  const swSync = store.getSourceSync("coldcard_sweep_watch");
  const htLast = htSync?.lastSyncAt ? new Date(htSync.lastSyncAt).getTime() : 0;
  const swLast = swSync?.lastSyncAt ? new Date(swSync.lastSyncAt).getTime() : 0;
  const vtLast = Math.max(htLast, swLast);
  if (ts - vtLast >= config.vercelTrackersSyncIntervalSec * 1000) {
    if (!store.hasPendingJob("sync_vercel_trackers")) {
      store.enqueueJob("sync_vercel_trackers", {}, JOB_PRIORITY.SYNC_VERCEL_TRACKERS);
    }
  }

  for (const h of store.listHackers()) {
    const sync = store.getSyncState(h.address);
    const lastPoll = sync?.lastPolledAt ? new Date(sync.lastPolledAt).getTime() : 0;
    if (ts - lastPoll >= config.cronIntervalSec * 1000 && !store.hasPendingJob("poll_hacker_address", h.address)) {
      store.enqueueJob("poll_hacker_address", { address: h.address }, JOB_PRIORITY.POLL_HACKER);
    }

    const balanceAt = h.liveBalanceAt ? new Date(h.liveBalanceAt).getTime() : 0;
    if (
      ts - balanceAt >= config.balanceRefreshIntervalSec * 1000 &&
      !store.hasPendingJob("refresh_live_balance", h.address)
    ) {
      store.enqueueJob("refresh_live_balance", { address: h.address }, JOB_PRIORITY.REFRESH_BALANCE);
    }
  }

  scheduleHackerBackfillHeal(store, config);

  const frontier = store.getDownstreamFrontier(config.crawlEnqueuePerCron, config.maxCrawlDepth);
  for (const row of frontier) {
    if (store.hasPendingJob("expand_downstream", row.address)) continue;
    store.setExpandStatus(row.address, "queued");
    store.enqueueJob("expand_downstream", { address: row.address, cron: true }, JOB_PRIORITY.CRON_EXPAND);
  }

  const pollCandidates = store.listDownstreamForPoll(
    config.downstreamPollEnqueuePerCron,
    config.maxCrawlDepth,
    config.downstreamPollIntervalSec,
  );
  for (const row of pollCandidates) {
    if (store.hasPendingJob("poll_downstream_address", row.address)) continue;
    store.enqueueJob("poll_downstream_address", { address: row.address }, JOB_PRIORITY.POLL_DOWNSTREAM);
  }
}
