CREATE INDEX IF NOT EXISTS idx_addresses_crawl_pending
  ON addresses(role, hop_from_hacker)
  WHERE expand_status = 'pending' AND role IN ('downstream', 'hacker');

CREATE INDEX IF NOT EXISTS idx_addresses_downstream_poll
  ON addresses(hop_from_hacker, expand_status)
  WHERE role = 'downstream' AND expand_status IN ('pending', 'expanded');
