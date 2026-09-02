import { describe, expect, it } from "vitest";
import { formatQuotaCount, formatQuotaUsageLine } from "./quotaFormat";

describe("quotaFormat", () => {
  it("formats quota usage line", () => {
    const line = formatQuotaUsageLine({
      rowsRead: 5_000_001,
      rowsWritten: 84_200,
      workersRequests: 92_100,
      rowsReadLimit: 5_000_000,
      rowsWrittenLimit: 100_000,
      workersRequestsLimit: 100_000,
    });
    expect(line).toContain("D1 reads: 5M/5M");
    expect(line).toContain("84.2K/100K");
    expect(formatQuotaCount(500)).toBe("500");
  });
});
