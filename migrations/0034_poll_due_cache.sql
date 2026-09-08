ALTER TABLE scheduler_state ADD COLUMN monitor_snapshot_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN downstream_poll_due_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN downstream_poll_due_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN downstream_poll_max_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN downstream_poll_interval_sec INTEGER NOT NULL DEFAULT 0;
