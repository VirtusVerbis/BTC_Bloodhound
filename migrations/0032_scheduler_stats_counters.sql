ALTER TABLE scheduler_state ADD COLUMN sync_snapshot_dirty INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduler_state ADD COLUMN total_in_sats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN total_out_sats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN victim_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN hacker_active_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN crawl_expanded_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN crawl_max_hop_reached INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN downstream_tree_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN downstream_tree_max_depth INTEGER NOT NULL DEFAULT 0;

UPDATE scheduler_state SET total_in_sats = (
  SELECT COALESCE(SUM(amount_sats), 0) FROM edges WHERE direction = 'in_to_hacker'
) WHERE id = 1;

UPDATE scheduler_state SET total_out_sats = (
  SELECT COALESCE(SUM(amount_sats), 0) FROM edges WHERE direction = 'out_from_hacker'
) WHERE id = 1;

UPDATE scheduler_state SET victim_count = (
  SELECT COUNT(*) FROM addresses WHERE role = 'victim'
) WHERE id = 1;

UPDATE scheduler_state SET hacker_active_count = (
  SELECT COUNT(*) FROM addresses WHERE is_flagged_hacker = 1 AND total_received_sats > 0
) WHERE id = 1;

UPDATE scheduler_state SET crawl_expanded_count = (
  SELECT COUNT(*) FROM addresses WHERE expand_status = 'expanded'
) WHERE id = 1;

UPDATE scheduler_state SET crawl_max_hop_reached = (
  SELECT COALESCE(MAX(hop_from_hacker), 0) FROM addresses WHERE role = 'downstream'
) WHERE id = 1;

UPDATE scheduler_state SET
  downstream_tree_count = (
    SELECT COUNT(*) FROM addresses WHERE role = 'downstream' AND hop_from_hacker < 10
  ),
  downstream_tree_max_depth = 10
WHERE id = 1;

UPDATE scheduler_state SET
  last_completed_job_at = (
    SELECT completed_at FROM jobs
    WHERE status = 'done' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  ),
  last_completed_job_type = (
    SELECT type FROM jobs
    WHERE status = 'done' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  )
WHERE id = 1 AND last_completed_job_at IS NULL;
