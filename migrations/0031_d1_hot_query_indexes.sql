CREATE INDEX IF NOT EXISTS idx_edges_direction_amount
  ON edges(direction, amount_sats);

CREATE INDEX IF NOT EXISTS idx_addresses_pending_crawl_count
  ON addresses(address)
  WHERE expand_status = 'pending'
    AND role IN ('downstream', 'hacker');

CREATE INDEX IF NOT EXISTS idx_sync_state_polled
  ON sync_state(last_polled_at, address);

CREATE INDEX IF NOT EXISTS idx_addresses_downstream_hop
  ON addresses(hop_from_hacker)
  WHERE role = 'downstream';
