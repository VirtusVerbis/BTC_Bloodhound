ALTER TABLE addresses ADD COLUMN hack_id TEXT NOT NULL DEFAULT 'coldcard';

CREATE INDEX IF NOT EXISTS idx_addresses_hackers_by_hack
  ON addresses(hack_id, total_received_sats DESC)
  WHERE is_flagged_hacker = 1;
