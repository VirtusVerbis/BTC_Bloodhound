import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { getHackerAddressSet, processTxForHackerContext } from "../graph/builder.js";
import { applyColdcardWatchSync, fetchColdcardWatch } from "../sources/coldcardwatch.js";

export async function runSeedPublicHackers(store: Store, seedFilePath: string): Promise<void> {
  const raw = await readFile(path.resolve(seedFilePath), "utf8");
  const data = JSON.parse(raw) as { hackers: Array<{ address: string; label?: string; source_url?: string }> };
  let delay = 0;
  for (const h of data.hackers) {
    store.upsertAddress({
      address: h.address,
      role: "hacker",
      label: h.label ?? null,
      source: "public_seed",
      isFlaggedHacker: true,
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    store.enqueueJob(
      "backfill_hacker_address",
      { address: h.address },
      JOB_PRIORITY.BACKFILL_HACKER,
      new Date(Date.now() + delay * 1000).toISOString(),
    );
    delay += 5;
  }
}

export async function runLoadLocalWatchlist(store: Store, localPath: string): Promise<void> {
  try {
    const raw = await readFile(path.resolve(localPath), "utf8");
    const data = JSON.parse(raw) as { hackers: Array<{ address: string; label?: string }> };
    for (const h of data.hackers) {
      const existing = store.getAddress(h.address);
      store.upsertAddress({
        address: h.address,
        role: "hacker",
        label: h.label ?? null,
        source: "local_config",
        isFlaggedHacker: true,
        hopFromHacker: 0,
      });
      if (!existing) {
        store.enqueueJob("backfill_hacker_address", { address: h.address }, JOB_PRIORITY.BACKFILL_HACKER);
      }
    }
  } catch {
    console.warn("No local watchlist found at", localPath);
  }
}

async function backfillHacker(store: Store, router: ChainRouter, address: string): Promise<void> {
  const hackers = getHackerAddressSet(store);
  const txs = await router.withProvider((p) => p.getAddressTxs(address));
  for (const t of [...txs].reverse()) {
    await processTxForHackerContext(store, router, t.txid, hackers, 0);
  }
  if (txs.length > 0) {
    store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  }
  store.setExpandStatus(address, "expanded");
}

async function pollHacker(store: Store, router: ChainRouter, address: string): Promise<void> {
  const sync = store.getSyncState(address);
  const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
  const hackers = getHackerAddressSet(store);
  for (const t of txs.reverse()) {
    await processTxForHackerContext(store, router, t.txid, hackers, 0);
  }
  if (txs.length > 0) {
    store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  }
}

async function expandDownstream(
  store: Store,
  router: ChainRouter,
  address: string,
  config: AppConfig,
): Promise<void> {
  const addr = store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const hackers = getHackerAddressSet(store);
  const txs = await router.withProvider((p) => p.getAddressTxs(address));
  for (const t of txs) {
    const tx = await router.withProvider((p) => p.getTx(t.txid));
    const hasSpend = tx.vin.some((i) => i.prevout?.scriptpubkey_address === address);
    if (hasSpend) {
      await processTxForHackerContext(store, router, t.txid, hackers, hop);
    }
  }
  store.setExpandStatus(address, "expanded");

  if ((hop ?? 0) + 1 >= config.maxCrawlDepth) {
    for (const e of store.getEdgesFromAddress(address)) {
      store.upsertAddress({
        address: e.toAddress,
        expandStatus: "max_depth",
      });
    }
  }
}

async function refreshBalance(store: Store, router: ChainRouter, address: string): Promise<void> {
  const stats = await router.withProvider((p) => p.getAddressStats(address));
  const funded = stats.chain_stats.funded_txo_sum + (stats.mempool_stats?.funded_txo_sum ?? 0);
  const spent = stats.chain_stats.spent_txo_sum + (stats.mempool_stats?.spent_txo_sum ?? 0);
  store.upsertAddress({
    address,
    liveBalanceSats: funded - spent,
    liveBalanceAt: new Date().toISOString(),
  });
}

async function syncColdcardwatch(store: Store, config: AppConfig): Promise<void> {
  const data = await fetchColdcardWatch(config.coldcardwatchBase);
  const prev = store.getSourceSync("coldcardwatch");
  if (prev?.lastContentHash === data.contentHash) return;
  applyColdcardWatchSync(store, data);
}

export async function processJob(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  job: Job,
): Promise<void> {
  const payload = JSON.parse(job.payloadJson) as Record<string, string | boolean>;
  switch (job.type) {
    case "seed_public_hackers":
      await runSeedPublicHackers(store, config.seedFilePath);
      break;
    case "backfill_hacker_address":
      await backfillHacker(store, router, payload.address as string);
      break;
    case "poll_hacker_address":
      await pollHacker(store, router, payload.address as string);
      break;
    case "expand_downstream":
      await expandDownstream(store, router, payload.address as string, config);
      break;
    case "refresh_live_balance":
      await refreshBalance(store, router, payload.address as string);
      break;
    case "sync_coldcardwatch":
      await syncColdcardwatch(store, config);
      break;
    case "process_tx":
      await processTxForHackerContext(
        store,
        router,
        payload.txid as string,
        getHackerAddressSet(store),
        0,
      );
      break;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

export async function processJobs(store: Store, router: ChainRouter, config: AppConfig): Promise<number> {
  let processed = 0;
  for (let i = 0; i < config.jobsPerTick; i++) {
    const job = store.claimNextJob();
    if (!job) break;
    try {
      if (job.type === "sync_coldcardwatch") {
        await syncColdcardwatch(store, config);
      } else {
        await processJob(store, router, config, job);
      }
      store.completeJob(job.id);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const backoff = Math.min(300, 30 * (job.attempts + 1));
      store.failJob(job.id, message, new Date(Date.now() + backoff * 1000).toISOString());
    }
  }
  return processed;
}
