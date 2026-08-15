ALTER TABLE addresses ADD COLUMN last_graph_activity_at TEXT;

UPDATE addresses AS h
SET last_graph_activity_at = (
  SELECT MAX(v.first_seen_at)
  FROM edges e
  INNER JOIN addresses v ON v.address = e.from_address AND v.role = 'victim'
  WHERE e.to_address = h.address
    AND e.direction = 'in_to_hacker'
    AND v.first_seen_at IS NOT NULL
)
WHERE h.is_flagged_hacker = 1
  AND EXISTS (
    SELECT 1
    FROM edges e
    INNER JOIN addresses v ON v.address = e.from_address AND v.role = 'victim'
    WHERE e.to_address = h.address
      AND e.direction = 'in_to_hacker'
      AND v.first_seen_at IS NOT NULL
  );
