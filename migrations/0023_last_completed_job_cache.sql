ALTER TABLE scheduler_state ADD COLUMN last_completed_job_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN last_completed_job_type TEXT;
ALTER TABLE scheduler_state ADD COLUMN last_completed_job_duration_ms INTEGER;
ALTER TABLE scheduler_state ADD COLUMN last_done_jobs_pruned_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN last_housekeeping_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN maintenance_prune_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN maintenance_run_json TEXT;
