import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "./index.js";
import {
  clampPollDueCount,
  downstreamPollEligibleWhereSql,
  isDownstreamPollEligibleAddress,
  listDownstreamNeverPolledSql,
  listDownstreamStalePolledSql,
  pollDueCountSql,
  pollDueNeverCountSql,
  pollDueStaleCountSql,
  sqlStringLiteral,
} from "./pollDueQuery.js";

describe("pollDueQuery", () => {
  it("sqlStringLiteral escapes single quotes", () => {
    expect(sqlStringLiteral("a'b")).toBe("'a''b'");
  });

  it("isDownstreamPollEligibleAddress mirrors SQL eligibility", () => {
    expect(
      isDownstreamPollEligibleAddress("downstream", "expanded", 1, 5, 100_000, 100_000),
    ).toBe(true);
    expect(
      isDownstreamPollEligibleAddress("downstream", "expanded", 1, 5, 99_999, 100_000),
    ).toBe(false);
    expect(isDownstreamPollEligibleAddress("downstream", "queued", 1, 5, 200_000, 100_000)).toBe(
      false,
    );
  });

  it("includes amount filter for pending and expanded when minExpandSats is set", () => {
    const where = downstreamPollEligibleWhereSql("a", 5, 100_000);
    expect(where).toContain("a.expand_status IN ('expanded', 'pending')");
    expect(where).toContain("a.inbound_sats >= 100000");
    expect(where).not.toContain("out_from_hacker");
    expect(where).not.toContain("a.expand_status = 'expanded'");
  });

  it("pollDueCountSql sums never-polled and stale-polled subqueries", () => {
    const sql = pollDueCountSql(5, "2020-01-01T00:00:00.000Z");
    expect(sql).toContain("AS count");
    expect(sql).toContain("last_polled_at IS NOT NULL");
    expect(sql).toContain("INNER JOIN addresses a");
    expect(sql).toContain("last_polled_at <= '2020-01-01T00:00:00.000Z'");
    expect(sql).not.toContain("last_polled_at >");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("pollDueNeverCountSql uses NOT EXISTS with IS NOT NULL", () => {
    const sql = pollDueNeverCountSql(5, 100_000);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("last_polled_at IS NOT NULL");
    expect(sql).toContain("inbound_sats >= 100000");
  });

  it("pollDueStaleCountSql joins sync_state on cutoff", () => {
    const sql = pollDueStaleCountSql(5, "2020-01-01T00:00:00.000Z");
    expect(sql).toContain("INNER JOIN addresses a");
    expect(sql).toContain("last_polled_at <= '2020-01-01T00:00:00.000Z'");
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

  it("uses poll-due indexes for hot count query shapes", () => {
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);

    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((row) => row.name);
    expect(indexNames).toContain("idx_addresses_poll_due");
    expect(indexNames).toContain("idx_sync_state_addr_last_polled");

    const stalePlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${pollDueStaleCountSql(5, "2020-01-01T00:00:00.000Z", 100_000)};`)
      .all() as Array<{ detail: string }>;
    const staleDetails = stalePlan.map((p) => p.detail).join("\n");
    expect(staleDetails).toMatch(/idx_sync_state_(polled|addr_last_polled)/);
  });

  it("clampPollDueCount floors at zero", () => {
    expect(clampPollDueCount(-3)).toBe(0);
    expect(clampPollDueCount(4.9)).toBe(4);
    expect(clampPollDueCount(Number.NaN)).toBe(0);
  });
});
