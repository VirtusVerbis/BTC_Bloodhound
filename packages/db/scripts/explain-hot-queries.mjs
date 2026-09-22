import { openDatabase, runMigrations } from "../dist/index.js";
import {
  pollDueCountSql,
  pollDueNeverCountSql,
  pollDueStaleCountSql,
} from "../dist/pollDueQuery.js";

function explain(sqlite, label, sql) {
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  console.log(`\n=== ${label} ===`);
  console.log(sql.trim().replace(/\s+/g, " ").slice(0, 200) + (sql.length > 200 ? "..." : ""));
  for (const row of plan) {
    console.log(`  ${row.id}|${row.parent}|${row.notused}| ${row.detail}`);
  }
  return plan.map((r) => r.detail).join("\n");
}

function seedEdges(sqlite, hacker, victimCount, edgesPerVictim) {
  const now = new Date().toISOString();
  const insertEdge = sqlite.prepare(`
    INSERT INTO edges (from_address, to_address, txid, amount_sats, block_time, direction)
    VALUES (?, ?, ?, ?, ?, 'in_to_hacker')
  `);
  const insertAddr = sqlite.prepare(`
    INSERT OR IGNORE INTO addresses (address, role, expand_status, hop_from_hacker, inbound_sats, created_at)
    VALUES (?, 'victim', 'expanded', 1, 0, ?)
  `);

  sqlite.transaction(() => {
    for (let v = 0; v < victimCount; v++) {
      const victim = `victim_${v}`;
      insertAddr.run(victim, now);
      for (let e = 0; e < edgesPerVictim; e++) {
        insertEdge.run(victim, hacker, `${victim}_tx_${e}`, 100_000 + e, now);
      }
    }
  })();
  sqlite.exec("ANALYZE edges");
  sqlite.exec("ANALYZE addresses");
  sqlite.exec("ANALYZE sync_state");
}

function seedPollDue(sqlite) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 3600_000).toISOString();
  const insertAddr = sqlite.prepare(`
    INSERT INTO addresses (address, role, expand_status, hop_from_hacker, inbound_sats, created_at)
    VALUES (?, 'downstream', 'expanded', 2, ?, ?)
  `);
  const insertSync = sqlite.prepare(`
    INSERT INTO sync_state (address, last_polled_at) VALUES (?, ?)
  `);

  sqlite.transaction(() => {
    insertAddr.run("down_never", 200_000, now);
    insertAddr.run("down_stale", 150_000, now);
    insertSync.run("down_stale", stale);
    insertAddr.run("down_fresh", 300_000, now);
    insertSync.run("down_fresh", now);
    insertAddr.run("down_low_inbound", 50_000, now);
  })();
  sqlite.exec("ANALYZE addresses");
  sqlite.exec("ANALYZE sync_state");
}

const { sqlite } = openDatabase(":memory:");
runMigrations(sqlite);

const indexes = sqlite
  .prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('edges', 'addresses', 'sync_state') ORDER BY tbl_name, name`,
  )
  .all();

console.log("=== Relevant indexes ===");
for (const row of indexes) {
  if (
    row.name.includes("edges") ||
    row.name.includes("poll") ||
    row.name.includes("sync_state")
  ) {
    console.log(`  ${row.name}: ${(row.sql ?? "").replace(/\s+/g, " ")}`);
  }
}

seedEdges(sqlite, "hacker_hot", 500, 500);
const edgeCount = sqlite.prepare("SELECT COUNT(*) AS c FROM edges").get().c;
console.log(`\nSeeded ${edgeCount} edges (500 victims x 500 edges each)`);

const victimScanPlan = explain(
  sqlite,
  "getVictimAddressSetForHacker (descending scan)",
  `
SELECT from_address
FROM edges
WHERE to_address = 'hacker_hot'
  AND direction = 'in_to_hacker'
  AND amount_sats >= 100000
ORDER BY amount_sats DESC
LIMIT 128
`,
);

const victimGroupPlan = explain(
  sqlite,
  "getVictimAddressSetForHacker (GROUP BY fallback)",
  `
SELECT from_address
FROM edges
WHERE to_address = 'hacker_hot'
  AND direction = 'in_to_hacker'
  AND amount_sats >= 100000
GROUP BY from_address
ORDER BY MAX(amount_sats) DESC
LIMIT 32
`,
);

const victimPeaksPlan = explain(
  sqlite,
  "getVictimAddressSetForHacker (peaks table)",
  `
SELECT from_address
FROM hacker_victim_peaks
WHERE hacker_address = 'hacker_hot'
  AND max_amount_sats >= 100000
ORDER BY max_amount_sats DESC
LIMIT 32
`,
);

const victimInPlan = explain(
  sqlite,
  "filterVictimTargetsOfHacker (DISTINCT + IN)",
  `
SELECT DISTINCT from_address
FROM edges
WHERE from_address IN ('victim_1', 'victim_2', 'victim_3')
  AND to_address = 'hacker_hot'
  AND direction = 'in_to_hacker'
  AND amount_sats >= 100000
`,
);

seedPollDue(sqlite);
const cutoff = new Date(Date.now() - 600_000).toISOString();
const neverPlan = explain(sqlite, "pollDueNeverCountSql", pollDueNeverCountSql(5, 100_000));
const stalePlan = explain(sqlite, "pollDueStaleCountSql", pollDueStaleCountSql(5, cutoff, 100_000));
const combinedPlan = explain(sqlite, "pollDueCountSql", pollDueCountSql(5, cutoff, 100_000));

console.log("\n=== Index usage checks ===");
const checks = [
  [
    "Victim scan uses inbound amount index",
    /idx_edges_to_(in_amount|dir_amount)/i.test(victimScanPlan),
  ],
  ["Victim GROUP BY uses idx_edges_to_dir_amount", /idx_edges_to_dir_amount/i.test(victimGroupPlan)],
  ["Victim GROUP BY avoids full table scan", !/SCAN edges$/i.test(victimGroupPlan)],
  [
    "Victim peaks uses idx_hacker_victim_peaks_top",
    /idx_hacker_victim_peaks_top/i.test(victimPeaksPlan),
  ],
  ["Victim IN uses idx_edges_from_dir_amount", /idx_edges_from_dir_amount/i.test(victimInPlan)],
  [
    "Never-polled uses downstream address index",
    /idx_addresses_(poll_due|downstream_hop|role_hop)/i.test(neverPlan),
  ],
  ["Never-polled avoids correlated subquery", !/CORRELATED SCALAR SUBQUERY/i.test(neverPlan)],
  ["Stale poll uses sync_state polled index", /idx_sync_state_(polled|addr_last_polled)/i.test(stalePlan)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}

process.exit(failed > 0 ? 1 : 0);
