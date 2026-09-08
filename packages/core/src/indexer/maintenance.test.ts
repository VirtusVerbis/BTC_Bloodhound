import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { runScheduledMaintenance } from "./maintenance.js";
import { runMaintenanceCli } from "./maintenanceCli.js";
import { createUnlimitedSubrequestBudget } from "./subrequestBudget.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), ...overrides };
}

describe("runScheduledMaintenance", () => {
  it("resumes prune on subsequent tick when pending", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("process_tx", { txid: "old" }, 1);
    await store.completeJob(id);
    sqlite
      .prepare("UPDATE jobs SET completed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", id);

    await store.updateSchedulerState({
      maintenancePrunePending: 1,
      maintenanceRunJson: JSON.stringify({ phase: "prune_done_jobs", jobsDeleted: 0 }),
    });

    const result = await runScheduledMaintenance(
      store,
      testConfig({ jobPruneEnabled: true }),
      createUnlimitedSubrequestBudget(),
      3,
      { skipNonCritical: false },
    );

    expect(result.jobsDeleted).toBe(1);
    expect(result.prunePending).toBe(false);
    expect((await store.getSchedulerState())?.maintenancePrunePending).toBe(0);
  });

  it("skips prune when completed_at backfill backlog remains", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.updateSchedulerState({ maintenancePrunePending: 1 });
    vi.spyOn(store, "countDoneJobsWithNullCompletedAt").mockResolvedValue(1);
    const pruneSpy = vi.spyOn(store, "pruneDoneJobs");

    const result = await runScheduledMaintenance(
      store,
      testConfig({ jobPruneEnabled: true }),
      createUnlimitedSubrequestBudget(),
      7200,
      { skipNonCritical: false },
    );

    expect(pruneSpy).not.toHaveBeenCalled();
    expect(result.jobsDeleted).toBe(0);
    expect(result.prunePending).toBe(true);
  });
});

describe("runMaintenanceCli", () => {
  it("completes maintenance on in-memory db", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("process_tx", { txid: "old" }, 1);
    await store.completeJob(id);
    sqlite
      .prepare("UPDATE jobs SET completed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", id);

    const result = await runMaintenanceCli(store, testConfig({ jobPruneEnabled: true }), {
      tickMs: 60_000,
    });

    expect(result.complete).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.session.jobsDeleted).toBeGreaterThanOrEqual(1);
    expect((await store.getSchedulerState())?.maintenancePrunePending).toBe(0);
  });

  it("aborts mid-run and leaves pending state for resume", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    for (let i = 0; i < 5; i++) {
      const id = await store.enqueueJob("process_tx", { txid: `old-${i}` }, 1);
      await store.completeJob(id);
      sqlite
        .prepare("UPDATE jobs SET completed_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", id);
    }

    const controller = new AbortController();
    const cfg = testConfig({
      jobPruneEnabled: true,
      jobPruneBatchSize: 1,
      jobPruneMaxBatchesPerRun: 1,
      jobPruneMaxDeletesPerRun: 1,
      maintenanceMaxBatchesPerTick: 1,
      maintenanceMaxWritesPerTick: 1,
    });

    let iterations = 0;
    const abortResult = await runMaintenanceCli(store, cfg, {
      tickMs: 60_000,
      signal: controller.signal,
      onProgress: () => {
        iterations++;
        if (iterations >= 2) controller.abort();
      },
    });

    expect(abortResult.aborted).toBe(true);
    expect(abortResult.complete).toBe(false);
    expect((await store.getSchedulerState())?.maintenancePrunePending).toBe(1);

    const resumeResult = await runMaintenanceCli(store, cfg, { tickMs: 60_000 });
    expect(resumeResult.complete).toBe(true);
    expect((await store.getSchedulerState())?.maintenancePrunePending).toBe(0);
  });

  it("dry-run reports counts without writes", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const id = await store.enqueueJob("process_tx", { txid: "old" }, 1);
    await store.completeJob(id);
    sqlite
      .prepare("UPDATE jobs SET completed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", id);

    const result = await runMaintenanceCli(store, testConfig({ jobPruneEnabled: true }), {
      dryRun: true,
    });

    expect(result.iterations).toBe(0);
    expect(result.session.jobsDeleted).toBe(0);
    expect((await store.getJob(id))?.status).toBe("done");
  });
});
