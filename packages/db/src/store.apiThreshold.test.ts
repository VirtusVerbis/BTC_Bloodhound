import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store, todayUtcDate } from "./index.js";

function yesterdayUtcDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe("daily API threshold counters", () => {
  function openStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return { sqlite, store: new Store(db) };
  }

  it("getMonitoringStatus zeros counts on UTC day change and preserves backoff/last-hit", async () => {
    const { sqlite, store } = openStore();
    const lastHit = "2026-09-11T23:40:00.000Z";
    const retryAfter = new Date(Date.now() + 300_000).toISOString();
    sqlite
      .prepare(
        `UPDATE scheduler_state SET
          api_threshold_day_utc = ?,
          api_threshold_count = 210,
          esplora_threshold_count = 207,
          mempool_threshold_count = 3,
          last_api_threshold_at = ?,
          last_esplora_threshold_at = ?,
          last_mempool_threshold_at = ?,
          esplora_strike_count = 5,
          esplora_retry_after_at = ?,
          mempool_strike_count = 0
        WHERE id = 1`,
      )
      .run(yesterdayUtcDate(), lastHit, lastHit, lastHit, retryAfter);

    const status = await store.getMonitoringStatus(600, 300);
    expect(status.apiThresholdCount).toBe(0);
    expect(status.chainApis![0]!.thresholdCount).toBe(0);
    expect(status.chainApis![1]!.thresholdCount).toBe(0);
    expect(status.chainApis![0]!.strikeCount).toBe(5);
    expect(status.chainApis![0]!.thresholdExceeded).toBe(true);
    expect(status.lastApiThresholdAt).toBe(lastHit);
    expect(status.chainApis![0]!.lastThresholdAt).toBe(lastHit);
    expect(status.chainApis![1]!.lastThresholdAt).toBe(lastHit);

    const state = await store.getSchedulerState();
    expect(state?.apiThresholdDayUtc).toBe(todayUtcDate());
    expect(state?.apiThresholdCount).toBe(0);
    expect(state?.esploraThresholdCount).toBe(0);
    expect(state?.mempoolThresholdCount).toBe(0);
    expect(state?.esploraStrikeCount).toBe(5);
    expect(state?.esploraRetryAfterAt).toBe(retryAfter);
    expect(state?.lastApiThresholdAt).toBe(lastHit);
    expect(state?.lastEsploraThresholdAt).toBe(lastHit);
  });

  it("same-day recordApiThreshold increments without reset", async () => {
    const { store } = openStore();
    const future = new Date(Date.now() + 300_000).toISOString();
    await store.recordApiThreshold("esplora", { retryAfterAt: future, strikeCount: 1 });
    await store.recordApiThreshold("esplora", { retryAfterAt: future, strikeCount: 2 });
    await store.recordApiThreshold("mempool", { retryAfterAt: future, strikeCount: 1 });

    const state = await store.getSchedulerState();
    expect(state?.apiThresholdDayUtc).toBe(todayUtcDate());
    expect(state?.esploraThresholdCount).toBe(2);
    expect(state?.mempoolThresholdCount).toBe(1);
    expect(state?.apiThresholdCount).toBe(3);
    expect(state?.esploraStrikeCount).toBe(2);
    expect(state?.mempoolStrikeCount).toBe(1);

    const status = await store.getMonitoringStatus(600, 300);
    expect(status.apiThresholdCount).toBe(3);
    expect(status.chainApis![0]!.thresholdCount).toBe(2);
    expect(status.chainApis![1]!.thresholdCount).toBe(1);
  });

  it("recordApiThreshold after day change starts at 1 for that provider", async () => {
    const { sqlite, store } = openStore();
    const lastHit = "2026-09-11T12:00:00.000Z";
    const future = new Date(Date.now() + 300_000).toISOString();
    sqlite
      .prepare(
        `UPDATE scheduler_state SET
          api_threshold_day_utc = ?,
          api_threshold_count = 210,
          esplora_threshold_count = 207,
          mempool_threshold_count = 3,
          last_esplora_threshold_at = ?,
          esplora_strike_count = 5
        WHERE id = 1`,
      )
      .run(yesterdayUtcDate(), lastHit);

    await store.recordApiThreshold("esplora", { retryAfterAt: future, strikeCount: 6 });

    const state = await store.getSchedulerState();
    expect(state?.apiThresholdDayUtc).toBe(todayUtcDate());
    expect(state?.esploraThresholdCount).toBe(1);
    expect(state?.mempoolThresholdCount).toBe(0);
    expect(state?.apiThresholdCount).toBe(1);
    expect(state?.esploraStrikeCount).toBe(6);
    expect(state?.esploraRetryAfterAt).toBe(future);
    expect(state?.lastEsploraThresholdAt).not.toBe(lastHit);
  });
});
