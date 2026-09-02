ALTER TABLE scheduler_state ADD COLUMN quota_day_utc TEXT;
ALTER TABLE scheduler_state ADD COLUMN d1_rows_read_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN d1_rows_written_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN workers_requests_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN d1_rows_read_cron INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN d1_rows_written_cron INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN workers_requests_cron INTEGER NOT NULL DEFAULT 0;
