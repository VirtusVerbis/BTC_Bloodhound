UPDATE scheduler_state SET crawl_pending_count = (
  SELECT COUNT(*) FROM addresses
  WHERE expand_status = 'pending' AND role IN ('downstream', 'hacker')
) WHERE id = 1;
