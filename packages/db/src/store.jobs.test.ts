import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("resetRunningJobs", () => {
  it("resets running jobs to pending and leaves done jobs unchanged", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const runningId = await store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    const doneId = await store.enqueueJob("poll_hacker_address", { address: "bc1qtest" }, 1);
    sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(runningId);
    await store.completeJob(doneId);

    expect(await store.resetRunningJobs()).toBe(1);
    expect((await store.getJob(runningId))?.status).toBe("pending");
    expect((await store.getJob(runningId))?.startedAt).toBeNull();
    expect((await store.getJob(doneId))?.status).toBe("done");
  });

  it("returns 0 when no running jobs exist", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    expect(await store.resetRunningJobs()).toBe(0);
  });

  it("clears started_at when reclaiming a claimed job", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    const claimed = await store.claimNextJob();
    expect(claimed?.startedAt).toBeTruthy();
    expect(await store.resetRunningJobs()).toBe(1);
    expect((await store.getJob(claimed!.id))?.startedAt).toBeNull();
    expect((await store.getJob(claimed!.id))?.status).toBe("pending");
  });
});

describe("job timing", () => {
  it("sets started_at on claim and completed_at on complete", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("refresh_btc_usd_price", {}, 1);
    const before = Date.now();
    const claimed = await store.claimNextJob();
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBeTruthy();
    expect(new Date(claimed!.startedAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);

    await new Promise((r) => setTimeout(r, 20));
    await store.completeJob(id);
    const done = await store.getJob(id);
    expect(done?.status).toBe("done");
    expect(done?.completedAt).toBeTruthy();
    expect(done?.startedAt).toBeTruthy();
    const duration = new Date(done!.completedAt!).getTime() - new Date(done!.startedAt!).getTime();
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("exposes last completed job type and duration in getMonitoringStatus", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("poll_hacker_address", { address: "a" }, 1);
    const first = await store.claimNextJob();
    await store.completeJob(first!.id);

    const id = await store.enqueueJob("sync_coldcardwatch", {}, 5);
    const claimed = await store.claimNextJob();
    expect(claimed?.id).toBe(id);
    await new Promise((r) => setTimeout(r, 25));
    await store.completeJob(id);

    const status = await store.getMonitoringStatus(3600, 3600);
    expect(status.lastCompletedJobType).toBe("sync_coldcardwatch");
    expect(status.lastCompletedJobAt).toBeTruthy();
    expect(status.lastJobAt).toBe(status.lastCompletedJobAt);
    expect(status.lastCompletedJobDurationMs).toBeGreaterThanOrEqual(0);
    expect(status.lastCompletedJobDurationMs).toBeLessThan(60_000);
  });
});

describe("hasPendingJob address match", () => {
  const ADDR_A = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const ADDR_B = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";

  it("matches pending jobs by json_extract address", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("poll_hacker_address", { address: ADDR_A }, 1);

    expect(await store.hasPendingJob("poll_hacker_address", ADDR_A)).toBe(true);
    expect(await store.hasPendingJob("poll_hacker_address", ADDR_B)).toBe(false);
    expect(await store.hasPendingJob("backfill_hacker_address", ADDR_A)).toBe(false);

    expect(await store.deleteActiveJobsForAddress(ADDR_A)).toBe(1);
    expect(await store.hasPendingJob("poll_hacker_address", ADDR_A)).toBe(false);
  });
});
