CREATE INDEX IF NOT EXISTS idx_edges_to_dir_amount
  ON edges(to_address, direction, amount_sats, from_address);
