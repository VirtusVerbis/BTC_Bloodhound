import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("crawl pending counter", () => {
  async function openStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return { sqlite, store: new Store(db) };
  }

  async function readCounter(store: Store) {
    const state = await store.getSchedulerState();
    return state?.crawlPendingCount ?? 0;
  }

  it("starts at zero", async () => {
    const { store } = await openStore();
    expect(await readCounter(store)).toBe(0);
    expect((await store.getCrawlStats()).crawlPendingCount).toBe(0);
  });

  it("increments when inserting downstream pending", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qdown1", role: "downstream", expandStatus: "pending" });
    expect(await readCounter(store)).toBe(1);
    expect((await store.getCrawlStats()).crawlPendingCount).toBe(1);
  });

  it("increments for pending hacker role", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qhacker", role: "hacker", expandStatus: "pending" });
    expect(await readCounter(store)).toBe(1);
  });

  it("does not count victim or non-pending downstream", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qvictim", role: "victim", expandStatus: "pending" });
    await store.upsertAddress({ address: "bc1qexpanded", role: "downstream", expandStatus: "expanded" });
    expect(await readCounter(store)).toBe(0);
  });

  it("decrements when expand status leaves pending", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qdown1", role: "downstream", expandStatus: "pending" });
    await store.setExpandStatus("bc1qdown1", "expanded");
    expect(await readCounter(store)).toBe(0);
  });

  it("decrements when role leaves downstream/hacker", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qdown1", role: "downstream", expandStatus: "pending" });
    await store.upsertAddress({ address: "bc1qdown1", role: "victim", expandStatus: "pending", forceRole: true });
    expect(await readCounter(store)).toBe(0);
  });

  it("increments when resetStuckExpandStatuses moves queued to pending", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qdown1", role: "downstream", expandStatus: "queued" });
    expect(await readCounter(store)).toBe(0);
    const reset = await store.resetStuckExpandStatuses();
    expect(reset).toBe(1);
    expect(await readCounter(store)).toBe(1);
  });

  it("upsertAddressesBatch adjusts counter incrementally without reconcile", async () => {
    const { store } = await openStore();
    await store.upsertAddressesBatch([
      { address: "bc1qdown1", role: "downstream", expandStatus: "pending" },
      { address: "bc1qdown2", role: "downstream", expandStatus: "pending" },
      { address: "bc1qvictim", role: "victim", expandStatus: "pending" },
    ]);
    expect(await readCounter(store)).toBe(2);
  });

  it("reconcileCrawlPendingCount repairs drift", async () => {
    const { sqlite, store } = await openStore();
    await store.upsertAddress({ address: "bc1qdown1", role: "downstream", expandStatus: "pending" });
    await store.upsertAddress({ address: "bc1qdown2", role: "hacker", expandStatus: "pending" });
    sqlite.prepare("UPDATE scheduler_state SET crawl_pending_count = 0 WHERE id = 1").run();
    expect(await readCounter(store)).toBe(0);
    expect(await store.reconcileCrawlPendingCount()).toBe(2);
    expect(await readCounter(store)).toBe(2);
  });
});
