import { describe, expect, it, vi } from "vitest";
import { D1RowMeter } from "@cointrace/db";
import {
  formatQuotaPct,
  formatSidecarD1QuotaLine,
  promptContinueOnWriteQuota,
  shouldWarnWrites,
} from "./sidecarD1Quota.js";

describe("sidecarD1Quota", () => {
  it("formatQuotaPct includes sidecar today UTC", () => {
    expect(formatQuotaPct(82100, 100_000)).toBe("82100/100000 (82.1%, sidecar today UTC)");
  });

  it("formatSidecarD1QuotaLine includes d1R and d1W", () => {
    const meter = new D1RowMeter("2026-08-31");
    meter.record(45230, 82100);
    const line = formatSidecarD1QuotaLine(meter, {
      readDailyLimit: 5_000_000,
      writeDailyLimit: 100_000,
      writeWarnPct: 90,
    });
    expect(line).toContain("d1R=");
    expect(line).toContain("d1W=");
    expect(line).toContain("sidecar today UTC");
    expect(line).toContain("resetIn=");
  });

  it("shouldWarnWrites at 90% threshold", () => {
    const meter = new D1RowMeter("2026-08-31");
    meter.record(0, 89_999);
    expect(shouldWarnWrites(meter, 100_000, 90)).toBe(false);
    meter.record(0, 1);
    expect(shouldWarnWrites(meter, 100_000, 90)).toBe(true);
  });

  it("promptContinueOnWriteQuota returns false for non-tty", async () => {
    const meter = new D1RowMeter("2026-08-31");
    meter.record(0, 95_000);
    const ask = vi.fn();
    const result = await promptContinueOnWriteQuota({
      meter,
      limits: { readDailyLimit: 5_000_000, writeDailyLimit: 100_000, writeWarnPct: 90 },
      ask,
      isTty: false,
      log: vi.fn(),
      logWarn: vi.fn(),
    });
    expect(result).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("promptContinueOnWriteQuota accepts Y", async () => {
    const meter = new D1RowMeter("2026-08-31");
    meter.record(0, 95_000);
    const result = await promptContinueOnWriteQuota({
      meter,
      limits: { readDailyLimit: 5_000_000, writeDailyLimit: 100_000, writeWarnPct: 90 },
      ask: async () => "y",
      isTty: true,
      log: vi.fn(),
      logWarn: vi.fn(),
    });
    expect(result).toBe(true);
  });
});
