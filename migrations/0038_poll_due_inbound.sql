CREATE INDEX IF NOT EXISTS idx_edges_to_out_amount
  ON edges(to_address, amount_sats)
  WHERE direction = 'out_from_hacker';

ALTER TABLE addresses ADD COLUMN inbound_sats INTEGER NOT NULL DEFAULT 0;

UPDATE addresses SET inbound_sats = COALESCE((
  SELECT SUM(e.amount_sats) FROM edges e
  WHERE e.to_address = addresses.address AND e.direction = 'out_from_hacker'
), 0);

CREATE INDEX IF NOT EXISTS idx_addresses_poll_due
  ON addresses(hop_from_hacker, inbound_sats)
  WHERE role = 'downstream' AND expand_status IN ('pending', 'expanded');
