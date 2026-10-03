DROP INDEX IF EXISTS idx_addresses_poll_due;
CREATE INDEX idx_addresses_poll_due
  ON addresses(inbound_sats, hop_from_hacker, address)
  WHERE role = 'downstream' AND expand_status IN ('pending', 'expanded');
