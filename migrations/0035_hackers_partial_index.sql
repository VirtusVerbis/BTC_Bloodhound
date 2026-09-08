CREATE INDEX IF NOT EXISTS idx_addresses_hackers_by_received
  ON addresses(total_received_sats DESC)
  WHERE is_flagged_hacker = 1;
