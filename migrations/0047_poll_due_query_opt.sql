CREATE INDEX IF NOT EXISTS idx_sync_state_addr_last_polled
  ON sync_state(address, last_polled_at);

ALTER TABLE scheduler_state ADD COLUMN downstream_poll_min_expand_sats INTEGER NOT NULL DEFAULT 0;
