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
    expect(where).toContain("a.expand_status IN ('pending', 'expanded')");
    expect(where).toContain("a.inbound_sats >= 100000");
    expect(where).not.toContain("out_from_hacker");
    expect(where).not.toContain("a.expand_status = 'expanded'");
  });

  it("pollDueCountSql counts eligible addresses in one pass", () => {
    const sql = pollDueCountSql(5, "2020-01-01T00:00:00.000Z", 100_000);
    expect(sql).toContain("AS count");
    expect(sql).toContain("LEFT JOIN sync_state s ON s.address = a.address");
    expect(sql).toContain(
      "s.last_polled_at IS NULL OR s.last_polled_at <= '2020-01-01T00:00:00.000Z'",
    );
    expect(sql).toContain("inbound_sats >= 100000");
    expect(sql).not.toContain("INNER JOIN");
    expect(sql).not.toContain("s.address IS NULL");
    expect(sql).not.toContain("NOT EXISTS");
    expect(sql).not.toContain("last_polled_at >");
  });

  it("pollDueNeverCountSql uses LEFT JOIN anti-join", () => {
    const sql = pollDueNeverCountSql(5, 100_000);
    expect(sql).toContain("LEFT JOIN sync_state s");
    expect(sql).toContain("s.address IS NULL");
    expect(sql).toContain("last_polled_at IS NOT NULL");
    expect(sql).toContain("inbound_sats >= 100000");
    expect(sql).not.toContain("NOT EXISTS");
  });

  it("pollDueStaleCountSql joins sync_state on cutoff", () => {
    const sql = pollDueStaleCountSql(5, "2020-01-01T00:00:00.000Z");
    expect(sql).toContain("INNER JOIN addresses a");
    expect(sql).toContain("last_polled_at <= '2020-01-01T00:00:00.000Z'");
  });

  it("listDownstreamNeverPolledSql uses LEFT JOIN anti-join and hop order", () => {
    const sql = listDownstreamNeverPolledSql(5, 3);
    expect(sql).toContain("LEFT JOIN sync_state s");
    expect(sql).toContain("s.address IS NULL");
    expect(sql).toContain("ORDER BY a.hop_from_hacker ASC");
    expect(sql).toContain("LIMIT 3");
    expect(sql).not.toContain("NOT EXISTS");
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

    const neverPlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${pollDueNeverCountSql(5, 100_000)};`)
      .all() as Array<{ detail: string }>;
    const neverDetails = neverPlan.map((p) => p.detail).join("\n");
    expect(neverDetails).not.toMatch(/CORRELATED SCALAR SUBQUERY/);

    const stalePlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${pollDueStaleCountSql(5, "2020-01-01T00:00:00.000Z", 100_000)};`)
      .all() as Array<{ detail: string }>;
    const staleDetails = stalePlan.map((p) => p.detail).join("\n");
    expect(staleDetails).toMatch(/idx_sync_state_(polled|addr_last_polled)/);

    const countPlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${pollDueCountSql(5, "2020-01-01T00:00:00.000Z", 100_000)};`)
      .all() as Array<{ detail: string }>;
    const countDetails = countPlan.map((p) => p.detail).join("\n");
    expect(countDetails).toMatch(/idx_addresses_poll_due/);
    expect(countDetails).toMatch(/inbound_sats/);
    expect(countDetails).not.toMatch(/CORRELATED SCALAR SUBQUERY/);
  });

  it("pollDueCountSql matches never-polled plus stale", () => {
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const cutoff = "2020-06-01T00:00:00.000Z";
    const insertAddress = sqlite.prepare(
      `INSERT INTO addresses (address, role, created_at, hop_from_hacker, expand_status, inbound_sats)
       VALUES (?, 'downstream', '2020-01-01T00:00:00.000Z', 1, 'expanded', 100000)`,
    );
    for (const address of ["never", "null-poll", "stale", "fresh", "below-floor"]) {
      insertAddress.run(address);
    }
    sqlite.prepare("UPDATE addresses SET inbound_sats = 1000 WHERE address = 'below-floor'").run();
    sqlite
      .prepare("INSERT INTO sync_state (address, last_polled_at) VALUES (?, ?)")
      .run("null-poll", null);
    sqlite
      .prepare("INSERT INTO sync_state (address, last_polled_at) VALUES (?, ?)")
      .run("stale", "2020-01-01T00:00:00.000Z");
    sqlite
      .prepare("INSERT INTO sync_state (address, last_polled_at) VALUES (?, ?)")
      .run("fresh", "2021-01-01T00:00:00.000Z");

    const never = sqlite.prepare(pollDueNeverCountSql(5, 100_000)).get() as { count: number };
    const stale = sqlite.prepare(pollDueStaleCountSql(5, cutoff, 100_000)).get() as { count: number };
    const combined = sqlite.prepare(pollDueCountSql(5, cutoff, 100_000)).get() as { count: number };
    expect(never.count).toBe(2);
    expect(stale.count).toBe(1);
    expect(combined.count).toBe(never.count + stale.count);
  });

  it("clampPollDueCount floors at zero", () => {
    expect(clampPollDueCount(-3)).toBe(0);
    expect(clampPollDueCount(4.9)).toBe(4);
    expect(clampPollDueCount(Number.NaN)).toBe(0);
  });
});
