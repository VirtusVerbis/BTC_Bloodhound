ALTER TABLE addresses ADD COLUMN expand_profile TEXT;
ALTER TABLE addresses ADD COLUMN relay_meta_json TEXT;
ALTER TABLE addresses ADD COLUMN fanout_meta_json TEXT;
ALTER TABLE edges ADD COLUMN edge_kind TEXT;
ALTER TABLE edges ADD COLUMN fanout_meta_json TEXT;
