CREATE INDEX IF NOT EXISTS idx_addresses_flagged_received
  ON addresses(is_flagged_hacker, total_received_sats DESC);
CREATE INDEX IF NOT EXISTS idx_addresses_role ON addresses(role);
CREATE INDEX IF NOT EXISTS idx_addresses_expand_status ON addresses(expand_status);
CREATE INDEX IF NOT EXISTS idx_addresses_role_hop ON addresses(role, hop_from_hacker);

CREATE INDEX IF NOT EXISTS idx_jobs_done_completed
  ON jobs(completed_at DESC, created_at DESC) WHERE status = 'done';

CREATE INDEX IF NOT EXISTS idx_edges_to_dir
  ON edges(to_address, direction);

CREATE INDEX IF NOT EXISTS idx_transactions_missing_op_return
  ON transactions(txid) WHERE op_return_display IS NULL;
