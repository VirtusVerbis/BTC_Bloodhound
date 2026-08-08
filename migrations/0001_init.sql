-- Cointrace D1 schema (mirrors packages/db runMigrations final state)

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
  last_polled_at TEXT,
  backfill_state_json TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  last_backfill_audit_at TEXT,
  chain_tx_count_at_audit INTEGER
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
  rate_limit_ms INTEGER NOT NULL DEFAULT 3000,
  last_provider_success_at TEXT,
  last_api_threshold_at TEXT,
  api_threshold_count INTEGER NOT NULL DEFAULT 0,
  backfill_heal_audit_index INTEGER NOT NULL DEFAULT 0,
  btc_usd_price INTEGER,
  btc_usd_price_at TEXT
);

INSERT OR IGNORE INTO scheduler_state (id, rate_limit_ms) VALUES (1, 3000);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
