ALTER TABLE scheduler_state ADD COLUMN esplora_strike_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN mempool_strike_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN esplora_retry_after_at TEXT;
ALTER TABLE scheduler_state ADD COLUMN mempool_retry_after_at TEXT;
