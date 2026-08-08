import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("resetRunningJobs", () => {
  it("resets running jobs to pending and leaves done jobs unchanged", () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const runningId = store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    const doneId = store.enqueueJob("poll_hacker_address", { address: "bc1qtest" }, 1);
    sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(runningId);
    store.completeJob(doneId);

    expect(store.resetRunningJobs()).toBe(1);
    expect(store.getJob(runningId)?.status).toBe("pending");
    expect(store.getJob(doneId)?.status).toBe("done");
  });

  it("returns 0 when no running jobs exist", () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    expect(store.resetRunningJobs()).toBe(0);
  });
});
