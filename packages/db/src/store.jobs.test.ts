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

    expect((await store.resetRunningJobs()).reclaimed).toBe(1);
    expect((await store.getJob(runningId))?.status).toBe("pending");
    expect((await store.getJob(runningId))?.startedAt).toBeNull();
    expect((await store.getJob(doneId))?.status).toBe("done");
  });

  it("returns 0 when no running jobs exist", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    expect((await store.resetRunningJobs()).reclaimed).toBe(0);
  });

  it("clears started_at when reclaiming a claimed job", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    const claimed = await store.claimNextJob();
    expect(claimed?.startedAt).toBeTruthy();
    expect((await store.resetRunningJobs()).reclaimed).toBe(1);
    expect((await store.getJob(claimed!.id))?.startedAt).toBeNull();
    expect((await store.getJob(claimed!.id))?.status).toBe("pending");
  });

  it("with staleMs leaves recently started running jobs alone", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("process_tx", { txid: "fresh" }, 1);
    const fresh = await store.claimNextJob();
    expect(fresh).toBeTruthy();

    const staleId = await store.enqueueJob("process_tx", { txid: "stale" }, 1);
    const old = new Date(Date.now() - 60_000).toISOString();
    sqlite.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(old, staleId);

    expect((await store.resetRunningJobs(30_000)).reclaimed).toBe(1);
    expect((await store.getJob(fresh!.id))?.status).toBe("running");
    expect((await store.getJob(staleId))?.status).toBe("pending");
  });

  it("defers after N unchanged stale reclaims", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qtest", chainCursor: "abc", processedIndex: 2 },
      10,
    );
    sqlite
      .prepare(
        "UPDATE jobs SET status = 'running', started_at = ?, reclaim_count = 0, reclaim_progress_json = ? WHERE id = ?",
      )
      .run(new Date(Date.now() - 60_000).toISOString(), '{"processedIndex":2,"headTxid":null,"chainCursor":"abc"}', id);

    const before = Date.now();
    const { reclaimed, deferred } = await store.resetRunningJobs(30_000, {
      jobReclaimDeferAfter: 1,
      jobReclaimDeferSec: 300,
    });
    expect(reclaimed).toBe(0);
    expect(deferred).toBe(1);
    const job = await store.getJob(id);
    expect(job?.status).toBe("pending");
    expect(job?.lastError).toBe("deferred: reclaimed without progress");
    const runAfterMs = new Date(job!.runAfter).getTime();
    expect(runAfterMs - before).toBeGreaterThanOrEqual(299_000);
    expect(runAfterMs - before).toBeLessThan(310_000);
  });

  it("reclaims when progress changed since last reclaim", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qtest", chainCursor: "abc", processedIndex: 5 },
      10,
    );
    sqlite
      .prepare(
        "UPDATE jobs SET status = 'running', started_at = ?, reclaim_count = 1, reclaim_progress_json = ? WHERE id = ?",
      )
      .run(
        new Date(Date.now() - 60_000).toISOString(),
        '{"processedIndex":2,"headTxid":null,"chainCursor":"abc"}',
        id,
      );

    const { reclaimed, deferred } = await store.resetRunningJobs(30_000, {
      jobReclaimDeferAfter: 1,
      jobReclaimDeferSec: 300,
    });
    expect(deferred).toBe(0);
    expect(reclaimed).toBe(1);
    const job = await store.getJob(id);
    expect(job?.status).toBe("pending");
    expect(job?.reclaimCount).toBe(2);
    expect(job?.lastError).toBe("reclaimed: stale running");
  });
});

describe("claimNextIngestJob", () => {
  it("prefers unreclaimed ingest job over reclaimed continuation", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const reclaimedId = await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qbackfill", chainCursor: "abc", processedIndex: 2 },
      10,
    );
    sqlite.prepare("UPDATE jobs SET reclaim_count = 1 WHERE id = ?").run(reclaimedId);

    const expandId = await store.enqueueJob(
      "expand_downstream",
      { address: "bc1qexpand", cron: true },
      8,
    );

    const claimed = await store.claimNextIngestJob({ preferContinuation: true });
    expect(claimed?.id).toBe(expandId);
  });

  it("claims reclaimed continuation when no alternatives", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const reclaimedId = await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qbackfill", chainCursor: "abc", processedIndex: 2 },
      10,
    );
    sqlite.prepare("UPDATE jobs SET reclaim_count = 1 WHERE id = ?").run(reclaimedId);

    const claimed = await store.claimNextIngestJob({ preferContinuation: true });
    expect(claimed?.id).toBe(reclaimedId);
  });
});

describe("hasPendingIngestContinuation", () => {
  it("returns true for pending continuation ingest jobs", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("poll_hacker_address", { address: "bc1qpoll" }, 6);
    await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qbackfill", chainCursor: "abc" },
      10,
    );

    expect(await store.hasPendingIngestContinuation()).toBe(true);
  });

  it("returns false when no continuation ingest jobs", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("expand_downstream", { address: "bc1qexpand", cron: true }, 8);
    expect(await store.hasPendingIngestContinuation()).toBe(false);
  });
});

describe("tick lease", () => {
  it("acquires once then rejects until cleared", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    expect(await store.tryAcquireTickLease(60_000)).toBe(true);
    expect(await store.tryAcquireTickLease(60_000)).toBe(false);
    await store.clearTickLease();
    expect(await store.tryAcquireTickLease(60_000)).toBe(true);
  });

  it("allows acquire after lease expiry", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    expect(await store.tryAcquireTickLease(60_000)).toBe(true);
    const past = new Date(Date.now() - 1000).toISOString();
    sqlite.prepare("UPDATE scheduler_state SET tick_lease_until = ? WHERE id = 1").run(past);
    expect(await store.tryAcquireTickLease(60_000)).toBe(true);
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

describe("enqueueJobIfAbsent", () => {
  const ADDR_A = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

  it("returns null on duplicate type+address", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const first = await store.enqueueJobIfAbsent(
      "poll_hacker_address",
      { address: ADDR_A },
      1,
      undefined,
      { address: ADDR_A },
    );
    const second = await store.enqueueJobIfAbsent(
      "poll_hacker_address",
      { address: ADDR_A },
      1,
      undefined,
      { address: ADDR_A },
    );

    expect(first).toBeGreaterThan(0);
    expect(second).toBeNull();
  });

  it("dedupes across dedupeTypes for same address", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJobIfAbsent(
      "audit_hacker_backfill",
      { address: ADDR_A },
      5,
      undefined,
      { dedupeTypes: ["backfill_hacker_address", "audit_hacker_backfill"], address: ADDR_A },
    );

    const blocked = await store.enqueueJobIfAbsent(
      "backfill_hacker_address",
      { address: ADDR_A },
      5,
      undefined,
      { dedupeTypes: ["backfill_hacker_address", "audit_hacker_backfill"], address: ADDR_A },
    );

    expect(blocked).toBeNull();
  });

  it("allows global jobs independently", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const first = await store.enqueueJobIfAbsent("sync_coldcardwatch", {}, 5);
    const second = await store.enqueueJobIfAbsent("sync_coldcardwatch", {}, 5);

    expect(first).toBeGreaterThan(0);
    expect(second).toBeNull();
  });
});

describe("insertAddressIfMissing", () => {
  it("returns true once and false on duplicate", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const first = await store.insertAddressIfMissing({
      address: "bc1qtestaddr",
      role: "hacker",
      isFlaggedHacker: true,
    });
    const second = await store.insertAddressIfMissing({
      address: "bc1qtestaddr",
      role: "victim",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = await store.getAddress("bc1qtestaddr");
    expect(row?.role).toBe("hacker");
  });
});

describe("listActiveJobs", () => {
  it("orders by priority desc then run_after asc and filters by status", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const lowId = await store.enqueueJob("refresh_btc_usd_price", {}, 1);
    const highId = await store.enqueueJob("backfill_hacker_address", { address: "bc1q" }, 10);
    await store.completeJob(lowId);
    sqlite.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(lowId);

    const summary = await store.getActiveJobSummary();
    expect(summary.some((r) => r.type === "backfill_hacker_address" && Number(r.count) === 1)).toBe(true);

    const jobs = await store.listActiveJobs({ statuses: ["pending"] });
    expect(jobs[0]!.id).toBe(highId);
    expect(await store.countActiveJobsMatching({ statuses: ["pending"] })).toBe(1);
  });
});
