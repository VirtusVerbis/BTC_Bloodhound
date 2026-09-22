CREATE TABLE hacker_victim_peaks (
  hacker_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  max_amount_sats INTEGER NOT NULL,
  PRIMARY KEY (hacker_address, from_address)
);

CREATE INDEX idx_hacker_victim_peaks_top
  ON hacker_victim_peaks(hacker_address, max_amount_sats DESC, from_address);

INSERT INTO hacker_victim_peaks (hacker_address, from_address, max_amount_sats)
SELECT to_address, from_address, MAX(amount_sats)
FROM edges
WHERE direction = 'in_to_hacker'
GROUP BY to_address, from_address;
