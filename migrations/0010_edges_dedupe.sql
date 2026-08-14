DELETE FROM edges
WHERE id NOT IN (
  SELECT MIN(id)
  FROM edges
  GROUP BY from_address, to_address, txid
);
