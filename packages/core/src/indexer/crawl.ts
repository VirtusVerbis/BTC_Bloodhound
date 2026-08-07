import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";

export function scheduleDownstreamCrawl(store: Store, config: AppConfig): void {
  const ts = Date.now();

  const cwSync = store.getSourceSync("coldcardwatch");
  const cwLast = cwSync?.lastSyncAt ? new Date(cwSync.lastSyncAt).getTime() : 0;
  if (ts - cwLast >= config.coldcardwatchSyncIntervalSec * 1000) {
    if (!store.hasPendingJob("sync_coldcardwatch")) {
      store.enqueueJob("sync_coldcardwatch", {}, JOB_PRIORITY.SYNC_COLDCARDWATCH);
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
