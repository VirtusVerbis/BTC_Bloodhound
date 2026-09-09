CREATE INDEX IF NOT EXISTS idx_sync_state_polled_addr
  ON sync_state(address) WHERE last_polled_at IS NOT NULL;
