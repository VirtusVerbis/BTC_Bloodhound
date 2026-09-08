CREATE INDEX IF NOT EXISTS idx_addresses_expand_role
  ON addresses(expand_status, role);
