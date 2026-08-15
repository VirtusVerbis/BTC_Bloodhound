import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Db } from "./store.js";

export type { Db } from "./store.js";

export function openDatabase(path: string): { sqlite: Database.Database; db: Db } {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

function backfillHackerGraphActivity(sqlite: Database.Database): void {
  sqlite.exec(`
    UPDATE addresses AS h
    SET last_graph_activity_at = (
      SELECT MAX(v.first_seen_at)
      FROM edges e
      INNER JOIN addresses v ON v.address = e.from_address AND v.role = 'victim'
      WHERE e.to_address = h.address
        AND e.direction = 'in_to_hacker'
        AND v.first_seen_at IS NOT NULL
    )
    WHERE h.is_flagged_hacker = 1
      AND EXISTS (
        SELECT 1
        FROM edges e
        INNER JOIN addresses v ON v.address = e.from_address AND v.role = 'victim'
        WHERE e.to_address = h.address
          AND e.direction = 'in_to_hacker'
          AND v.first_seen_at IS NOT NULL
      );
  `);

  const hackers = sqlite
    .prepare("SELECT address FROM addresses WHERE is_flagged_hacker = 1;")
    .all() as Array<{ address: string }>;
  const maxDownstreamStmt = sqlite.prepare(`
    WITH RECURSIVE tree(addr) AS (
      SELECT ?
      UNION
      SELECT e.to_address
      FROM edges e
      INNER JOIN tree t ON e.from_address = t.addr
      WHERE e.direction = 'out_from_hacker'
    )
    SELECT MAX(a.first_seen_at) AS max_seen
    FROM addresses a
    INNER JOIN tree ON a.address = tree.addr
    WHERE a.role = 'downstream' AND a.first_seen_at IS NOT NULL;
  `);
  const mergeStmt = sqlite.prepare(`
    UPDATE addresses
    SET last_graph_activity_at = ?
    WHERE address = ?
      AND (last_graph_activity_at IS NULL OR last_graph_activity_at < ?);
  `);
  for (const { address } of hackers) {
    const row = maxDownstreamStmt.get(address) as { max_seen: string | null } | undefined;
    if (!row?.max_seen) continue;
    mergeStmt.run(row.max_seen, address, row.max_seen);
  }
}

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      address TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'unknown',
      label TEXT,
      source TEXT NOT NULL DEFAULT 'derived',
      is_flagged_hacker INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      hop_from_hacker INTEGER,
      expand_status TEXT NOT NULL DEFAULT 'pending',
      last_expanded_at TEXT,
      total_received_sats INTEGER NOT NULL DEFAULT 0,
      live_balance_sats INTEGER,
      live_balance_at TEXT
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      txid TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      block_time TEXT,
      hop_from_hacker INTEGER,
      direction TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_address);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_address);
    CREATE INDEX IF NOT EXISTS idx_edges_txid ON edges(txid);

    DELETE FROM edges
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM edges
      GROUP BY from_address, to_address, txid
    );

    CREATE UNIQUE INDEX IF NOT EXISTS edges_from_to_txid_uq
      ON edges (from_address, to_address, txid);

    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      block_height INTEGER,
      block_time TEXT,
      fee_sats INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      address TEXT PRIMARY KEY,
      last_seen_txid TEXT,
      last_block_height INTEGER,
      last_polled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 1,
      run_after TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority, run_after);

    DROP TABLE IF EXISTS address_submissions;

    CREATE TABLE IF NOT EXISTS source_sync_state (
      source TEXT PRIMARY KEY,
      last_sync_at TEXT,
      last_address_count INTEGER,
      last_content_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduler_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      next_provider_call_at TEXT,
      last_provider_used TEXT,
      rate_limit_ms INTEGER NOT NULL DEFAULT 3000
    );

    INSERT OR IGNORE INTO scheduler_state (id, rate_limit_ms) VALUES (1, 3000);

    UPDATE edges
    SET block_time = (
      SELECT block_time FROM transactions WHERE transactions.txid = edges.txid
    )
    WHERE block_time IS NULL
      AND EXISTS (
        SELECT 1 FROM transactions
        WHERE transactions.txid = edges.txid AND block_time IS NOT NULL
      );
  `);

  const schedulerCols = sqlite.prepare("PRAGMA table_info(scheduler_state)").all() as Array<{ name: string }>;
  if (!schedulerCols.some((c) => c.name === "last_provider_success_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN last_provider_success_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "last_api_threshold_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN last_api_threshold_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "api_threshold_count")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN api_threshold_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "backfill_heal_audit_index")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN backfill_heal_audit_index INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "btc_usd_price")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN btc_usd_price INTEGER`);
  }
  if (!schedulerCols.some((c) => c.name === "btc_usd_price_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN btc_usd_price_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "btc_usd_refresh_attempt_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN btc_usd_refresh_attempt_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "hacker_poll_index")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN hacker_poll_index INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "maintenance_cron_counter")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN maintenance_cron_counter INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "tick_lease_until")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN tick_lease_until TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "last_esplora_threshold_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN last_esplora_threshold_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "last_mempool_threshold_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN last_mempool_threshold_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "esplora_threshold_count")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN esplora_threshold_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "mempool_threshold_count")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN mempool_threshold_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "queue_scheduling_paused")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN queue_scheduling_paused INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "esplora_strike_count")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN esplora_strike_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "mempool_strike_count")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN mempool_strike_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!schedulerCols.some((c) => c.name === "esplora_retry_after_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN esplora_retry_after_at TEXT`);
  }
  if (!schedulerCols.some((c) => c.name === "mempool_retry_after_at")) {
    sqlite.exec(`ALTER TABLE scheduler_state ADD COLUMN mempool_retry_after_at TEXT`);
  }

  const syncCols = sqlite.prepare("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>;
  if (!syncCols.some((c) => c.name === "backfill_state_json")) {
    sqlite.exec(`ALTER TABLE sync_state ADD COLUMN backfill_state_json TEXT`);
  }
  if (!syncCols.some((c) => c.name === "backfill_complete")) {
    sqlite.exec(`ALTER TABLE sync_state ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0`);
  }
  if (!syncCols.some((c) => c.name === "last_backfill_audit_at")) {
    sqlite.exec(`ALTER TABLE sync_state ADD COLUMN last_backfill_audit_at TEXT`);
  }
  if (!syncCols.some((c) => c.name === "chain_tx_count_at_audit")) {
    sqlite.exec(`ALTER TABLE sync_state ADD COLUMN chain_tx_count_at_audit INTEGER`);
  }

  const jobCols = sqlite.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobCols.some((c) => c.name === "started_at")) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN started_at TEXT`);
  }
  if (!jobCols.some((c) => c.name === "completed_at")) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN completed_at TEXT`);
  }
  if (!jobCols.some((c) => c.name === "reclaim_count")) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!jobCols.some((c) => c.name === "reclaim_progress_json")) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN reclaim_progress_json TEXT`);
  }

  const addressCols = sqlite.prepare("PRAGMA table_info(addresses)").all() as Array<{ name: string }>;
  if (!addressCols.some((c) => c.name === "expand_profile")) {
    sqlite.exec(`ALTER TABLE addresses ADD COLUMN expand_profile TEXT`);
  }
  if (!addressCols.some((c) => c.name === "relay_meta_json")) {
    sqlite.exec(`ALTER TABLE addresses ADD COLUMN relay_meta_json TEXT`);
  }
  if (!addressCols.some((c) => c.name === "fanout_meta_json")) {
    sqlite.exec(`ALTER TABLE addresses ADD COLUMN fanout_meta_json TEXT`);
  }
  let addedGraphActivityCol = false;
  if (!addressCols.some((c) => c.name === "last_graph_activity_at")) {
    sqlite.exec(`ALTER TABLE addresses ADD COLUMN last_graph_activity_at TEXT`);
    addedGraphActivityCol = true;
  }

  if (addedGraphActivityCol) {
    backfillHackerGraphActivity(sqlite);
  }

  const edgeCols = sqlite.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>;
  if (!edgeCols.some((c) => c.name === "edge_kind")) {
    sqlite.exec(`ALTER TABLE edges ADD COLUMN edge_kind TEXT`);
  }
  if (!edgeCols.some((c) => c.name === "fanout_meta_json")) {
    sqlite.exec(`ALTER TABLE edges ADD COLUMN fanout_meta_json TEXT`);
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export * from "./schema.js";
export * from "./store.js";
// D1 helper is also available via `@cointrace/db/d1` (avoids bundling better-sqlite3 in Workers).
export { createD1Store, instrumentD1Binding, type D1Binding, type D1Db, type D1SubrequestSink } from "./d1.js";
