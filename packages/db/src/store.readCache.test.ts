import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("read cache", () => {
  let store: Store;

  beforeEach(() => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    store = new Store(db);
  });

  it("listHackersCached serves fresh cache without re-querying addresses", async () => {
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 5000,
      label: "H1",
    });
    await store.refreshFlaggedHackersCache();

    await store.upsertAddress({
      address: "bc1qother",
      role: "hacker",
      totalReceivedSats: 1000,
    });

    const cached = await store.listHackersCached();
    expect(cached).toHaveLength(1);
    expect(cached[0]!.address).toBe("bc1qhacker");
  });

  it("listHackersCached filters by q without SQL when cache is fresh", async () => {
    await store.upsertAddress({
      address: "bc1qAlpha",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 5000,
      label: "Alpha",
    });
    await store.upsertAddress({
      address: "bc1qBeta",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 3000,
      label: "Beta",
    });
    await store.refreshFlaggedHackersCache();

    const filtered = await store.listHackersCached({ q: "beta", activeOnly: true });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.address).toBe("bc1qBeta");
  });

  it("does not invalidate cache when isFlaggedHacker is unchanged on re-upsert", async () => {
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 5000,
      label: "H1",
    });
    await store.refreshFlaggedHackersCache();

    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 6000,
      label: "H1 updated",
    });

    const cached = await store.listHackersCached();
    expect(cached).toHaveLength(1);
    expect(cached[0]!.address).toBe("bc1qhacker");
    expect(cached[0]!.totalReceivedSats).toBe(5000);
  });

  it("invalidates flagged hackers cache when isFlaggedHacker is upserted", async () => {
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 5000,
    });
    await store.refreshFlaggedHackersCache();

    await store.upsertAddress({
      address: "bc1qnew",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 2000,
    });

    const rows = await store.listHackersCached();
    expect(rows.map((r) => r.address).sort()).toEqual(["bc1qhacker", "bc1qnew"].sort());
  });

  it("maybeRefreshSyncSnapshot skips when snapshot is fresh and not dirty", async () => {
    const snapshot = await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });

    const again = await store.maybeRefreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    expect(again?.at).toBe(snapshot.at);
  });

  it("maybeRefreshSyncSnapshot refreshes when job snapshot is dirty", async () => {
    await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    await store.markJobSnapshotDirty();

    const snapshot = await store.maybeRefreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    expect(snapshot).not.toBeNull();
  });

  it("edge upsert does not dirty monitor snapshot", async () => {
    await store.upsertAddress({
      address: "bc1qdown",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);
    const first = await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qa",
        toAddress: "bc1qb",
        txid: "tx-edge",
        amountSats: 100,
        direction: "out_from_hacker",
      },
    ]);

    const again = await store.maybeRefreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    expect(again?.at).toBe(first.at);
    expect(again?.monitor.downstreamPollDueCount).toBe(first.monitor.downstreamPollDueCount);
  });

  it("getSyncSnapshot returns null when params mismatch", async () => {
    await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });

    const snap = await store.getSyncSnapshot({
      maxCrawlDepth: 3,
      downstreamPollIntervalSec: 600,
    });
    expect(snap).toBeNull();
  });

  it("refreshSyncSnapshot includes stats counts", async () => {
    await store.upsertAddress({ address: "bc1qvictim", role: "victim" });
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      totalReceivedSats: 100,
    });

    const snapshot = await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });

    expect(snapshot.stats.victimCount).toBe(1);
    expect(snapshot.stats.hackerCount).toBe(1);
    expect(snapshot.v).toBe(1);
  });

  it("getStats uses snapshot stats when fresh", async () => {
    await store.upsertAddress({ address: "bc1qvictim", role: "victim" });
    await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });

    await store.upsertAddress({ address: "bc1qvictim2", role: "victim" });

    const stats = await store.getStats({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    expect(stats.victimCount).toBe(1);
  });

  it("getStats uses scheduler lastCompletedJobAt when snapshot stats are fresh", async () => {
    const jobId = await store.enqueueJob("process_tx", { txid: "abc" }, 1);
    await store.completeJob(jobId);
    await store.refreshSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });

    const stats = await store.getStats({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    const state = await store.getSchedulerState();
    expect(stats.lastJobAt).toBe(state?.lastCompletedJobAt);
  });
});
