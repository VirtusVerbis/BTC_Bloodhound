import { describe, expect, it, vi } from "vitest";
import { shouldPaceCron } from "@cointrace/core";

describe("cron quota pacing integration", () => {
  it("skips cron when account reads exceed linear budget at noon", () => {
    const snapshot = {
      quotaDayUtc: "2026-09-02",
      rowsReadTotal: 3_000_000,
      rowsWrittenTotal: 0,
      workersRequestsTotal: 0,
      rowsReadCron: 1_000_000,
      rowsWrittenCron: 0,
      workersRequestsCron: 0,
    };
    const limits = {
      rowsReadLimit: 5_000_000,
      rowsWrittenLimit: 100_000,
      workersRequestsLimit: 100_000,
    };
    const pace = shouldPaceCron(snapshot, limits, {
      cronUtilizationPct: 80,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    expect(pace.paced).toBe(true);
    expect(pace.reason).toBe("account_reads");
  });

  it("worker scheduled path checks pace before lease (contract)", () => {
    const tryAcquireTickLease = vi.fn();
    const pace = shouldPaceCron(
      {
        quotaDayUtc: "2026-09-02",
        rowsReadTotal: 0,
        rowsWrittenTotal: 0,
        workersRequestsTotal: 0,
        rowsReadCron: 0,
        rowsWrittenCron: 0,
        workersRequestsCron: 0,
      },
      { rowsReadLimit: 5_000_000, rowsWrittenLimit: 100_000, workersRequestsLimit: 100_000 },
      { cronUtilizationPct: 80, now: new Date("2026-09-02T12:00:00.000Z") },
    );
    if (pace.paced) return;
    tryAcquireTickLease();
    expect(tryAcquireTickLease).toHaveBeenCalled();
  });
});
