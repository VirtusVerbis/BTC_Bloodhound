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
    expect((await store.getJob(doneId))?.status).toBe("done");
  });

  it("returns 0 when no running jobs exist", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.enqueueJob("process_tx", { txid: "abc123" }, 1);
    expect(await store.resetRunningJobs()).toBe(0);
  });
});
