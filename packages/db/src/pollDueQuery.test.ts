import { describe, expect, it } from "vitest";
import {
  clampPollDueCount,
  downstreamPollEligibleWhereSql,
  listDownstreamNeverPolledSql,
  listDownstreamStalePolledSql,
  pollDueCountSql,
  sqlStringLiteral,
} from "./pollDueQuery.js";

describe("pollDueQuery", () => {
  it("sqlStringLiteral escapes single quotes", () => {
    expect(sqlStringLiteral("a'b")).toBe("'a''b'");
  });

  it("includes amount filter for pending when minExpandSats is set", () => {
    const where = downstreamPollEligibleWhereSql("a", 5, 100_000);
    expect(where).toContain("a.expand_status = 'expanded'");
    expect(where).toContain(">= 100000");
    expect(where).toContain("out_from_hacker");
  });

  it("pollDueCountSql subtracts recently polled from eligible", () => {
    const sql = pollDueCountSql(5, "2020-01-01T00:00:00.000Z");
    expect(sql).toContain("SELECT MAX(0,");
    expect(sql).toContain("last_polled_at > '2020-01-01T00:00:00.000Z'");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("listDownstreamNeverPolledSql uses NOT EXISTS and hop order", () => {
    const sql = listDownstreamNeverPolledSql(5, 3);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("last_polled_at IS NOT NULL");
    expect(sql).toContain("ORDER BY a.hop_from_hacker ASC");
    expect(sql).toContain("LIMIT 3");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("listDownstreamStalePolledSql joins sync_state and orders by last_polled_at", () => {
    const sql = listDownstreamStalePolledSql(5, "2020-01-01T00:00:00.000Z", 2);
    expect(sql).toContain("INNER JOIN addresses a");
    expect(sql).toContain("last_polled_at <= '2020-01-01T00:00:00.000Z'");
    expect(sql).toContain("ORDER BY s.last_polled_at ASC, a.hop_from_hacker ASC");
    expect(sql).toContain("LIMIT 2");
  });

  it("clampPollDueCount floors at zero", () => {
    expect(clampPollDueCount(-3)).toBe(0);
    expect(clampPollDueCount(4.9)).toBe(4);
    expect(clampPollDueCount(Number.NaN)).toBe(0);
  });
});
