ALTER TABLE scheduler_state ADD COLUMN last_esplora_threshold_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN last_mempool_threshold_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN esplora_threshold_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN mempool_threshold_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN queue_scheduling_paused INTEGER NOT NULL DEFAULT 0;
