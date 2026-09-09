import { describe, expect, it } from "vitest";
import {
  clampPollDueCount,
  downstreamPollEligibleWhereSql,
  pollDueCountSql,
  sqlStringLiteral,
} from "./pollDueQuery.js";

describe("pollDueQuery", () => {
  it("sqlStringLiteral escapes single quotes", () => {
    expect(sqlStringLiteral("a'b")).toBe("'a''b'");
  });

  it("downstreamPollEligibleWhereSql includes role, expand_status, and hop", () => {
    const where = downstreamPollEligibleWhereSql("a", 5);
    expect(where).toContain("a.role = 'downstream'");
    expect(where).toContain("expand_status IN ('expanded', 'pending')");
    expect(where).toContain("hop_from_hacker < 5");
  });

  it("pollDueCountSql subtracts recently polled from eligible", () => {
    const sql = pollDueCountSql(5, "2020-01-01T00:00:00.000Z");
    expect(sql).toContain("SELECT MAX(0,");
    expect(sql).toContain("last_polled_at > '2020-01-01T00:00:00.000Z'");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("clampPollDueCount floors at zero", () => {
    expect(clampPollDueCount(-3)).toBe(0);
    expect(clampPollDueCount(4.9)).toBe(4);
    expect(clampPollDueCount(Number.NaN)).toBe(0);
  });
});
