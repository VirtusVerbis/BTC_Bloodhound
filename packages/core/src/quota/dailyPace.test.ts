import { describe, expect, it } from "vitest";
import {
  computeLinearAllowance,
  computeUtcDayProgress,
  formatQuotaCount,
  formatQuotaUsageLine,
  shouldPaceCron,
  type QuotaUsageSnapshot,
} from "./dailyPace.js";

const limits = {
  rowsReadLimit: 5_000_000,
  rowsWrittenLimit: 100_000,
  workersRequestsLimit: 100_000,
};

function snapshot(overrides: Partial<QuotaUsageSnapshot> = {}): QuotaUsageSnapshot {
  return {
    quotaDayUtc: "2026-09-02",
    rowsReadTotal: 0,
    rowsWrittenTotal: 0,
    workersRequestsTotal: 0,
    rowsReadCron: 0,
    rowsWrittenCron: 0,
    workersRequestsCron: 0,
    ...overrides,
  };
}

describe("computeUtcDayProgress", () => {
  it("returns 0 at UTC midnight", () => {
    const progress = computeUtcDayProgress(new Date("2026-09-02T00:00:00.000Z"));
    expect(progress).toBe(0);
  });

  it("returns ~0.5 at noon UTC", () => {
    const progress = computeUtcDayProgress(new Date("2026-09-02T12:00:00.000Z"));
    expect(progress).toBeCloseTo(0.5, 5);
  });
});

describe("computeLinearAllowance", () => {
  it("scales limit by day progress", () => {
    expect(computeLinearAllowance(5_000_000, 0.5)).toBe(2_500_000);
  });
});

describe("shouldPaceCron", () => {
  const noon = new Date("2026-09-02T12:00:00.000Z");

  it("does not pace when usage is below allowances", () => {
    const result = shouldPaceCron(
      snapshot({
        rowsReadTotal: 1_000_000,
        rowsReadCron: 500_000,
      }),
      limits,
      { cronUtilizationPct: 80, now: noon },
    );
    expect(result.paced).toBe(false);
  });

  it("paces when account reads exceed linear budget", () => {
    const result = shouldPaceCron(
      snapshot({ rowsReadTotal: 3_000_000 }),
      limits,
      { cronUtilizationPct: 80, now: noon },
    );
    expect(result.paced).toBe(true);
    expect(result.reason).toBe("account_reads");
  });

  it("paces when cron reads exceed cron slice", () => {
    const result = shouldPaceCron(
      snapshot({
        rowsReadTotal: 1_500_000,
        rowsReadCron: 2_100_000,
      }),
      limits,
      { cronUtilizationPct: 80, now: noon },
    );
    expect(result.paced).toBe(true);
    expect(result.reason).toBe("cron_reads");
  });

  it("does not pace at 100% cron utilization when under account budget", () => {
    const result = shouldPaceCron(
      snapshot({
        rowsReadTotal: 2_000_000,
        rowsReadCron: 2_000_000,
      }),
      limits,
      { cronUtilizationPct: 100, now: noon },
    );
    expect(result.paced).toBe(false);
  });
});

describe("formatQuotaCount", () => {
  it("formats millions and thousands", () => {
    expect(formatQuotaCount(5_000_001)).toBe("5M");
    expect(formatQuotaCount(4_200_000)).toBe("4.2M");
    expect(formatQuotaCount(84_200)).toBe("84.2K");
    expect(formatQuotaCount(500)).toBe("500");
  });
});

describe("formatQuotaUsageLine", () => {
  it("includes reads writes and requests", () => {
    const line = formatQuotaUsageLine(
      { rowsReadTotal: 5_000_001, rowsWrittenTotal: 84_200, workersRequestsTotal: 92_100 },
      limits,
    );
    expect(line).toContain("D1 reads: 5M/5M");
    expect(line).toContain("D1 writes: 84.2K/100K");
    expect(line).toContain("Requests: 92.1K/100K");
  });
});
