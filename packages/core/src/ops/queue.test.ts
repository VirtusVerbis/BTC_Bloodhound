import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { JOB_PRIORITY, loadConfig } from "../config.js";
import {
  enrichQueueJob,
  listQueue,
  summarizeJobPayload,
} from "./queue.js";

const config = loadConfig();

describe("summarizeJobPayload", () => {
  it("surfaces backfill continuation details", () => {
    const details = summarizeJobPayload("backfill_hacker_address", {
      address: "bc1qtest",
      pendingTxids: ["tx1", "tx2"],
      chainCursor: "cursor1",
      processedIndex: 1,
    });
    expect(details.address).toBe("bc1qtest");
    expect(details.continuation).toBe(true);
    expect(details.pendingTxidsCount).toBe(2);
    expect(details.chainCursor).toBe("cursor1");
  });

  it("marks expand_downstream cron payloads", () => {
    const details = summarizeJobPayload("expand_downstream", {
      address: "bc1qdown",
      cron: true,
    });
    expect(details.address).toBe("bc1qdown");
    expect(details.cron).toBe(true);
  });
});

describe("listQueue", () => {
  async function setupStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    return { store, sqlite };
  }

  it("returns summary counts and enriched jobs in claim order", async () => {
    const { store, sqlite } = await setupStore();

    await store.enqueueJob("refresh_btc_usd_price", {}, JOB_PRIORITY.REFRESH_BTC_USD);
    const expandId = await store.enqueueJob(
      "expand_downstream",
      { address: "bc1qexpand", cron: true },
      JOB_PRIORITY.CRON_EXPAND,
    );
    await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qback", pendingTxids: ["tx1"] },
      JOB_PRIORITY.BACKFILL_HACKER,
    );
    sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(expandId);

    const result = await listQueue(store, config, { limit: 10 });

    expect(result.summary.total).toBe(3);
    expect(result.summary.byStatus.pending).toBe(2);
    expect(result.summary.byStatus.running).toBe(1);
    expect(result.summary.byType.expand_downstream).toBe(1);
    expect(result.jobs[0]!.type).toBe("backfill_hacker_address");
    expect(result.jobs[0]!.priorityName).toBe("BACKFILL_HACKER");
    expect(result.jobs[0]!.details.continuation).toBe(true);
    expect(result.jobs[1]!.type).toBe("expand_downstream");
    expect(result.jobs[1]!.details.cron).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("filters by status and type", async () => {
    const { store } = await setupStore();
    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, JOB_PRIORITY.POLL_HACKER);
    await store.enqueueJob("poll_downstream_address", { address: "bc1qb" }, JOB_PRIORITY.POLL_DOWNSTREAM);

    const pendingOnly = await listQueue(store, config, { status: "pending", type: "poll_hacker_address" });
    expect(pendingOnly.summary.total).toBe(1);
    expect(pendingOnly.jobs).toHaveLength(1);
    expect(pendingOnly.jobs[0]!.type).toBe("poll_hacker_address");
  });

  it("sets truncated when limit is below total", async () => {
    const { store } = await setupStore();
    await store.enqueueJob("process_tx", { txid: "tx1" }, JOB_PRIORITY.PROCESS_TX);
    await store.enqueueJob("process_tx", { txid: "tx2" }, JOB_PRIORITY.PROCESS_TX);

    const result = await listQueue(store, config, { limit: 1 });
    expect(result.jobs).toHaveLength(1);
    expect(result.summary.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects unknown job type filter", async () => {
    const { store } = await setupStore();
    await expect(listQueue(store, config, { type: "not_a_real_job" })).rejects.toThrow(/Unknown job type/);
  });

  it("includes nextCron preview when requested", async () => {
    const { store } = await setupStore();
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
      source: "ops",
      expandStatus: "pending",
    });

    const result = await listQueue(store, config, { nextCron: true });
    expect(result.nextCron).toBeDefined();
    expect(result.nextCron!.note).toMatch(/scheduleDownstreamCrawl/);
  });
});

describe("enrichQueueJob", () => {
  it("flags runAfterDue for future run_after", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const job = enrichQueueJob({
      id: 1,
      type: "process_tx",
      payloadJson: JSON.stringify({ txid: "abc" }),
      status: "pending",
      priority: 4,
      runAfter: future,
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    });
    expect(job.runAfterDue).toBe(false);
    expect(job.jobClass).toBe("maint");
  });
});
