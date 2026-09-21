import { describe, expect, it, vi } from "vitest";
import { D1RowMeter, recordD1ResultMeta, todayUtcDate } from "./d1RowMeter.js";

describe("D1RowMeter", () => {
  it("accumulates reads and writes", () => {
    const fixedNow = new Date("2026-08-31T12:00:00.000Z");
    const meter = new D1RowMeter("2026-08-31");
    meter.record(100, 5, fixedNow);
    meter.record(50, 2, fixedNow);
    expect(meter.snapshot()).toEqual({
      utcDate: "2026-08-31",
      rowsRead: 150,
      rowsWritten: 7,
    });
  });

  it("records meta from D1 result", () => {
    const meter = new D1RowMeter("2026-08-31");
    recordD1ResultMeta({ meta: { rows_read: 5000, rows_written: 3 } }, meter);
    expect(meter.snapshot().rowsRead).toBe(5000);
    expect(meter.snapshot().rowsWritten).toBe(3);
  });

  it("rolls over at UTC day boundary", () => {
    const meter = new D1RowMeter("2026-08-31");
    meter.record(1000, 500);
    const listener = vi.fn();
    meter.onRollover(listener);

    const rolled = meter.record(10, 1, new Date("2026-09-01T00:00:01.000Z"));

    expect(rolled).toBe(true);
    expect(meter.snapshot()).toEqual({
      utcDate: "2026-09-01",
      rowsRead: 10,
      rowsWritten: 1,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("loadSnapshot restores state", () => {
    const meter = new D1RowMeter();
    meter.loadSnapshot({ utcDate: "2026-08-31", rowsRead: 42, rowsWritten: 7 });
    expect(meter.snapshot().rowsRead).toBe(42);
    expect(meter.snapshot().rowsWritten).toBe(7);
  });

  it("suppress routes row increments to overhead", () => {
    const fixedNow = new Date("2026-08-31T12:00:00.000Z");
    const meter = new D1RowMeter("2026-08-31");
    meter.record(10, 2, fixedNow);
    meter.suppress();
    meter.record(100, 50, fixedNow);
    expect(meter.snapshot()).toEqual({
      utcDate: "2026-08-31",
      rowsRead: 10,
      rowsWritten: 2,
    });
    expect(meter.drainOverhead()).toEqual({ reads: 100, writes: 50 });
    meter.unsuppress();
    meter.record(5, 1, fixedNow);
    expect(meter.snapshot().rowsRead).toBe(15);
    expect(meter.snapshot().rowsWritten).toBe(3);
  });

  it("suppress is re-entrant", () => {
    const fixedNow = new Date("2026-08-31T12:00:00.000Z");
    const meter = new D1RowMeter("2026-08-31");
    meter.suppress();
    meter.suppress();
    meter.record(99, 1, fixedNow);
    meter.unsuppress();
    meter.record(1, 0, fixedNow);
    expect(meter.snapshot().rowsRead).toBe(0);
    expect(meter.drainOverhead()).toEqual({ reads: 100, writes: 1 });
    meter.unsuppress();
    meter.record(1, 0, fixedNow);
    expect(meter.snapshot().rowsRead).toBe(1);
  });

  it("drainOverhead resets overhead accumulators", () => {
    const fixedNow = new Date("2026-08-31T12:00:00.000Z");
    const meter = new D1RowMeter("2026-08-31");
    meter.suppress();
    meter.record(7, 3, fixedNow);
    expect(meter.drainOverhead()).toEqual({ reads: 7, writes: 3 });
    expect(meter.drainOverhead()).toEqual({ reads: 0, writes: 0 });
    meter.unsuppress();
  });
});

describe("todayUtcDate", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    expect(todayUtcDate(new Date("2026-08-31T23:59:59.000Z"))).toBe("2026-08-31");
    expect(todayUtcDate(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });
});
