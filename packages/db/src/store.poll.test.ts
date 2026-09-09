import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("listDownstreamForPoll", () => {
  it("orders never-polled before recently polled", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "recent",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "stale",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertSyncState("recent", { lastSeenTxid: "tx1" });
    sqlite
      .prepare("UPDATE sync_state SET last_polled_at = ? WHERE address = ?")
      .run("2020-01-01T00:00:00.000Z", "recent");

    const due = await store.listDownstreamForPoll(10, 5, 600);
    expect(due.map((r) => r.address)).toEqual(["stale", "recent"]);
  });

  it("countDownstreamPollDue matches poll-eligible downstream nodes", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "due",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "recent",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertSyncState("recent", { lastSeenTxid: "tx1" });
    sqlite
      .prepare("UPDATE sync_state SET last_polled_at = ? WHERE address = ?")
      .run(new Date().toISOString(), "recent");

    expect(await store.countDownstreamPollDue(5, 600)).toBe(1);
    expect((await store.listDownstreamForPoll(10, 5, 600)).map((r) => r.address)).toEqual(["due"]);
  });

  it("countDownstreamPollDue matches listDownstreamForPoll for mixed poll states", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "never-polled",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "stale-poll",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "recent-poll",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertSyncState("stale-poll", { lastSeenTxid: "tx1" });
    await store.upsertSyncState("recent-poll", { lastSeenTxid: "tx2" });
    sqlite
      .prepare("UPDATE sync_state SET last_polled_at = ? WHERE address = ?")
      .run("2020-01-01T00:00:00.000Z", "stale-poll");
    sqlite
      .prepare("UPDATE sync_state SET last_polled_at = ? WHERE address = ?")
      .run(new Date().toISOString(), "recent-poll");

    const listed = await store.listDownstreamForPoll(10, 5, 600);
    expect(listed.map((r) => r.address).sort()).toEqual(["never-polled", "stale-poll"]);
    expect(await store.countDownstreamPollDue(5, 600)).toBe(2);
  });

  it("excludes nodes at max crawl depth", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "deep",
      role: "downstream",
      hopFromHacker: 5,
      expandStatus: "expanded",
    });

    const due = await store.listDownstreamForPoll(10, 5, 600);
    expect(due).toHaveLength(0);
  });

  it("getDownstreamMonitorStatsCached reuses poll due count when cache is fresh", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "due",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);

    const first = await store.getDownstreamMonitorStatsCached(5, 600);
    expect(first.downstreamPollDueCount).toBe(1);

    sqlite
      .prepare(
        "UPDATE scheduler_state SET downstream_poll_due_count = 999, downstream_poll_due_at = ? WHERE id = 1",
      )
      .run(new Date().toISOString());

    const cached = await store.getDownstreamMonitorStatsCached(5, 600);
    expect(cached.downstreamPollDueCount).toBe(999);
  });

  it("getDownstreamMonitorStatsCached recomputes when monitor snapshot is dirty", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "due",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);
    await store.getDownstreamMonitorStatsCached(5, 600);

    sqlite
      .prepare("UPDATE scheduler_state SET downstream_poll_due_count = 999 WHERE id = 1")
      .run();
    await store.markMonitorSnapshotDirty();

    const refreshed = await store.getDownstreamMonitorStatsCached(5, 600, { forceRefresh: true });
    expect(refreshed.downstreamPollDueCount).toBe(1);
  });

  it("getDownstreamMonitorStatsCached recomputes when cache TTL expires", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "due",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);
    await store.getDownstreamMonitorStatsCached(5, 600);

    sqlite
      .prepare(
        "UPDATE scheduler_state SET downstream_poll_due_count = 999, downstream_poll_due_at = ? WHERE id = 1",
      )
      .run("2020-01-01T00:00:00.000Z");

    const refreshed = await store.getDownstreamMonitorStatsCached(5, 600);
    expect(refreshed.downstreamPollDueCount).toBe(1);
  });

  it("touchSyncPoll decrements poll due count when cache is fresh", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "due",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);
    await store.getDownstreamMonitorStatsCached(5, 600);
    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(1);

    await store.touchSyncPoll("due");

    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(0);
    const state = await store.getSchedulerState();
    expect(state?.monitorSnapshotDirty).toBe(0);
  });

  it("upsertSyncState decrements poll due count when cache is fresh", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "due",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);
    await store.getDownstreamMonitorStatsCached(5, 600);
    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(1);

    await store.upsertSyncState("due", { lastSeenTxid: "tx1", lastBlockHeight: 100 });

    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(0);
    const state = await store.getSchedulerState();
    expect(state?.monitorSnapshotDirty).toBe(0);
  });

  it("upsertAddressesBatch increments poll due count without marking monitor dirty when cache is fresh", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.reconcileDownstreamTreeCount(5);
    await store.getDownstreamMonitorStatsCached(5, 600);
    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(0);

    await store.upsertAddressesBatch([
      {
        address: "newdown",
        role: "downstream",
        hopFromHacker: 1,
        expandStatus: "expanded",
      },
    ]);

    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(1);
    const state = await store.getSchedulerState();
    expect(state?.monitorSnapshotDirty).toBe(0);
  });

  it("upsertAddress increments poll due count when node becomes poll-eligible", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.reconcileDownstreamTreeCount(5);
    await store.getDownstreamMonitorStatsCached(5, 600);

    await store.upsertAddress({
      address: "newdown",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });

    expect((await store.getDownstreamMonitorStatsCached(5, 600)).downstreamPollDueCount).toBe(1);
    const state = await store.getSchedulerState();
    expect(state?.monitorSnapshotDirty).toBe(0);
  });
});
