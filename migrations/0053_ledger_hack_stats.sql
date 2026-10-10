INSERT INTO hack_stats (hack_id) VALUES ('ledger') ON CONFLICT(hack_id) DO NOTHING;
