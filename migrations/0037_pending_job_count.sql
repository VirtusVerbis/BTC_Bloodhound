ALTER TABLE scheduler_state ADD COLUMN pending_job_count INTEGER NOT NULL DEFAULT 0;

UPDATE scheduler_state SET pending_job_count = (
  SELECT COUNT(*) FROM jobs WHERE status = 'pending'
) WHERE id = 1;
