CREATE INDEX IF NOT EXISTS idx_edges_from_dir_amount
  ON edges(from_address, direction, amount_sats, to_address);
