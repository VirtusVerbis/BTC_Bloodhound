CREATE UNIQUE INDEX IF NOT EXISTS edges_from_to_txid_uq
  ON edges (from_address, to_address, txid);
