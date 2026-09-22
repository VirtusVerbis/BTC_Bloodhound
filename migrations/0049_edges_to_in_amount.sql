CREATE INDEX IF NOT EXISTS idx_edges_to_in_amount
  ON edges(to_address, amount_sats DESC, from_address)
  WHERE direction = 'in_to_hacker';
