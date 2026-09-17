CREATE TABLE hack_stats (
  hack_id TEXT PRIMARY KEY,
  victim_count INTEGER NOT NULL DEFAULT 0,
  hacker_count INTEGER NOT NULL DEFAULT 0,
  total_in_sats INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE hack_victims (
  hack_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  PRIMARY KEY (hack_id, from_address)
);

CREATE INDEX IF NOT EXISTS idx_hack_victims_from ON hack_victims(from_address);

INSERT INTO hack_stats (hack_id) VALUES ('coldcard'), ('liquid');

INSERT INTO hack_victims (hack_id, from_address)
SELECT DISTINCT a.hack_id, e.from_address
FROM edges e
INNER JOIN addresses a ON e.to_address = a.address
WHERE e.direction = 'in_to_hacker' AND a.is_flagged_hacker = 1
ON CONFLICT DO NOTHING;

UPDATE hack_stats SET
  victim_count = (
    SELECT COUNT(*) FROM hack_victims hv WHERE hv.hack_id = hack_stats.hack_id
  ),
  hacker_count = (
    SELECT COUNT(*) FROM addresses a
    WHERE a.hack_id = hack_stats.hack_id
      AND a.is_flagged_hacker = 1
      AND a.total_received_sats > 0
  ),
  total_in_sats = (
    SELECT COALESCE(SUM(a.total_received_sats), 0) FROM addresses a
    WHERE a.hack_id = hack_stats.hack_id AND a.is_flagged_hacker = 1
  );
