import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { runScheduledMaintenance } from "./maintenance.js";
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
