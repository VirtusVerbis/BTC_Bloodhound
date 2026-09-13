CREATE INDEX IF NOT EXISTS idx_jobs_pending_type_due
  ON jobs(type, priority DESC, run_after, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_pending_due
  ON jobs(priority DESC, run_after, created_at, type, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_active_type
  ON jobs(type)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_jobs_active_type_addr
  ON jobs(type, json_extract(payload_json, '$.address'))
  WHERE status IN ('pending', 'running');
