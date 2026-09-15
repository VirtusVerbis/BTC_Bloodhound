CREATE INDEX IF NOT EXISTS idx_transactions_missing_op_return_height
  ON transactions(block_height, txid)
  WHERE op_return_display IS NULL;
DROP INDEX IF EXISTS idx_transactions_missing_op_return;

CREATE INDEX IF NOT EXISTS idx_jobs_pending_ingest_due
  ON jobs(priority DESC, run_after, created_at)
  WHERE status = 'pending'
    AND type IN ('backfill_hacker_address', 'audit_hacker_backfill', 'expand_downstream');

CREATE INDEX IF NOT EXISTS idx_jobs_pending_run_after
  ON jobs(run_after)
  WHERE status = 'pending';

ALTER TABLE scheduler_state ADD COLUMN active_expand_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN active_backfill_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN active_audit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_state ADD COLUMN active_process_tx_count INTEGER NOT NULL DEFAULT 0;

UPDATE scheduler_state SET
  active_expand_count = (
    SELECT COUNT(*) FROM jobs
    WHERE type = 'expand_downstream' AND status IN ('pending', 'running')
  ),
  active_backfill_count = (
    SELECT COUNT(*) FROM jobs
    WHERE type = 'backfill_hacker_address' AND status IN ('pending', 'running')
  ),
  active_audit_count = (
    SELECT COUNT(*) FROM jobs
    WHERE type = 'audit_hacker_backfill' AND status IN ('pending', 'running')
  ),
  active_process_tx_count = (
    SELECT COUNT(*) FROM jobs
    WHERE type = 'process_tx' AND status IN ('pending', 'running')
  )
WHERE id = 1;
