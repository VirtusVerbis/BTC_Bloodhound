import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("last completed job cache", () => {
  it("getLastCompletedJobSummary returns latest done job with completed_at", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const older = await store.enqueueJob("process_tx", { txid: "old" }, 1);
    const newer = await store.enqueueJob("poll_hacker_address", { address: "bc1q" }, 1);
    await store.completeJob(older);
    await store.completeJob(newer);
    sqlite
      .prepare("UPDATE jobs SET completed_at = ?, created_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", older);
    sqlite
      .prepare("UPDATE jobs SET completed_at = ?, created_at = ? WHERE id = ?")
      .run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", newer);
    await store.updateSchedulerState({
      lastCompletedJobAt: null,
      lastCompletedJobType: null,
      lastCompletedJobDurationMs: null,
    });

    const summary = await store.getLastCompletedJobSummary();
    expect(summary.type).toBe("poll_hacker_address");
    expect(summary.at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("completeJob updates scheduler last_completed_job cache", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("process_tx", { txid: "abc" }, 1);
    await store.completeJob(id);

    const state = await store.getSchedulerState();
    expect(state?.lastCompletedJobType).toBe("process_tx");
    expect(state?.lastCompletedJobAt).toBeTruthy();
  });

  it("getLastCompletedJobSummary reads scheduler cache without jobs scan ordering", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.updateSchedulerState({
      lastCompletedJobAt: "2026-06-01T00:00:00.000Z",
      lastCompletedJobType: "cached_type",
      lastCompletedJobDurationMs: 42,
    });

    const summary = await store.getLastCompletedJobSummary();
    expect(summary).toEqual({ type: "cached_type", durationMs: 42, at: "2026-06-01T00:00:00.000Z" });
  });

  it("seedLastCompletedJobCache populates scheduler from indexed query", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("expand_downstream", { address: "bc1q" }, 1);
    await store.completeJob(id);
    await store.updateSchedulerState({
      lastCompletedJobAt: null,
      lastCompletedJobType: null,
      lastCompletedJobDurationMs: null,
    });

    expect(await store.seedLastCompletedJobCache()).toBe(true);
    const state = await store.getSchedulerState();
    expect(state?.lastCompletedJobType).toBe("expand_downstream");
    expect(state?.lastCompletedJobAt).toBeTruthy();
  });
});

describe("maintenance batch orchestrators", () => {
  it("backfillDoneJobCompletedAt updates only NULL completed_at on done rows", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("process_tx", { txid: "a" }, 1);
    await store.completeJob(id);
    sqlite.prepare("UPDATE jobs SET completed_at = NULL WHERE id = ?").run(id);

    const result = await store.backfillDoneJobCompletedAt({ batchSize: 10, maxBatchesPerRun: 1 });
    expect(result.affected).toBe(1);
    expect(result.complete).toBe(true);
    expect((await store.getJob(id))?.completedAt).toBeTruthy();
  });

  it("pruneDoneJobs deletes only stale done rows and respects caps", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const keep = await store.enqueueJob("process_tx", { txid: "keep" }, 1);
    const drop = await store.enqueueJob("process_tx", { txid: "drop" }, 1);
    const pending = await store.enqueueJob("process_tx", { txid: "pending" }, 1);
    await store.completeJob(keep);
    await store.completeJob(drop);
    const old = "2020-01-01T00:00:00.000Z";
    const recent = new Date().toISOString();
    sqlite.prepare("UPDATE jobs SET completed_at = ? WHERE id = ?").run(old, drop);
    sqlite.prepare("UPDATE jobs SET completed_at = ? WHERE id = ?").run(recent, keep);

    const result = await store.pruneDoneJobs({
      retentionDays: 5,
      batchSize: 10,
      maxBatchesPerRun: 1,
      maxPerRun: 10,
    });
    expect(result.affected).toBe(1);
    expect(await store.getJob(drop)).toBeUndefined();
    expect((await store.getJob(keep))?.status).toBe("done");
    expect((await store.getJob(pending))?.status).toBe("pending");
  });

  it("pruneStaleRateLimits removes only stale keys", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").run(
      "stale-ip",
      stale,
    );
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").run(
      "fresh-ip",
      fresh,
    );

    const result = await store.pruneStaleRateLimits({
      inactiveSec: 7 * 24 * 60 * 60,
      batchSize: 10,
      maxBatchesPerRun: 1,
    });
    expect(result.affected).toBe(1);
    expect(sqlite.prepare("SELECT key FROM rate_limits").all()).toEqual([{ key: "fresh-ip" }]);
  });

  it("pruneOrphanSyncState removes sync rows without addresses", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({ address: "bc1qlive", role: "hacker" });
    sqlite.prepare("INSERT INTO sync_state (address) VALUES (?)").run("bc1qorphan");
    sqlite.prepare("INSERT INTO sync_state (address) VALUES (?)").run("bc1qlive");

    const result = await store.pruneOrphanSyncState({ batchSize: 10, maxBatchesPerRun: 1 });
    expect(result.affected).toBe(1);
    expect(sqlite.prepare("SELECT address FROM sync_state").all()).toEqual([{ address: "bc1qlive" }]);
  });

  it("buildMaintenanceStatus computes next prune tick", () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const status = store.buildMaintenanceStatus(
      {
        id: 1,
        maintenanceCronCounter: 100,
        maintenancePrunePending: 0,
        lastDoneJobsPrunedAt: null,
        lastHousekeepingAt: null,
        maintenanceRunJson: null,
      } as Awaited<ReturnType<Store["getSchedulerState"]>>,
      { jobPruneEnabled: true, jobDoneRetentionDays: 5, jobPruneIntervalDays: 5 },
      Date.parse("2026-01-01T12:00:00.000Z"),
    );
    expect(status.status).toBe("scheduled");
    expect(status.ticksUntilPrune).toBe(5 * 1440 - 100);
    expect(status.nextPruneAt).toBeTruthy();
  });

  it("estimateMaintenanceWork counts rows per maintenance phase", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const backfillJob = await store.enqueueJob("process_tx", { txid: "bf" }, 1);
    await store.completeJob(backfillJob);
    sqlite.prepare("UPDATE jobs SET completed_at = NULL WHERE id = ?").run(backfillJob);

    const oldJob = await store.enqueueJob("process_tx", { txid: "old" }, 1);
    await store.completeJob(oldJob);
    sqlite
      .prepare("UPDATE jobs SET completed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", oldJob);

    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").run(
      "stale-ip",
      stale,
    );
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").run(
      "fresh-ip",
      fresh,
    );

    await store.upsertAddress({ address: "bc1qlive", role: "hacker" });
    sqlite.prepare("INSERT INTO sync_state (address) VALUES (?)").run("bc1qorphan");
    sqlite.prepare("INSERT INTO sync_state (address) VALUES (?)").run("bc1qlive");

    const estimate = await store.estimateMaintenanceWork({
      jobDoneRetentionDays: 5,
      rateLimitPruneInactiveDays: 7,
    });
    expect(estimate.backfill).toBe(1);
    expect(estimate.pruneJobs).toBe(1);
    expect(estimate.rateLimits).toBe(1);
    expect(estimate.syncOrphans).toBe(1);
    expect(estimate.total).toBe(4);
  });
});
