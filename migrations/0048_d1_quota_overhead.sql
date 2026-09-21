ALTER TABLE scheduler_state ADD COLUMN d1_rows_read_overhead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN d1_rows_written_overhead INTEGER NOT NULL DEFAULT 0;
