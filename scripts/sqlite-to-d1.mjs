#!/usr/bin/env node
/**
 * Export local SQLite data and import into Cloudflare D1 (local or remote).
 *
 * Usage:
 *   node scripts/sqlite-to-d1.mjs [--local] [--db path] [--clear]
 *
 * Prerequisites:
 *   - Checkpoint local DB (pause writers, PRAGMA wal_checkpoint(FULL))
 *   - Apply D1 migrations first: pnpm db:d1:migrate [--local]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const isLocal = args.includes("--local");
const clear = args.includes("--clear");
const dbIdx = args.indexOf("--db");
const dbPath = path.resolve(
  dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : "data/cointrace.db",
);

const TABLES = [
  "addresses",
  "edges",
  "transactions",
  "sync_state",
  "jobs",
  "source_sync_state",
  "scheduler_state",
];

const BATCH_ROWS = 50;

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`Local DB not found: ${dbPath}`);
    process.exit(1);
  }

  const sqlite = new Database(dbPath, { readonly: true });
  const outDir = path.resolve(".wrangler/tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const sqlPath = path.join(outDir, "sqlite-to-d1.sql");

  const parts = [];
  parts.push("PRAGMA foreign_keys = OFF;");

  if (clear) {
    for (const t of [...TABLES].reverse()) {
      parts.push(`DELETE FROM ${t};`);
    }
  }

  for (const table of TABLES) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (cols.length === 0) {
      console.warn(`Skipping missing table: ${table}`);
      continue;
    }
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    console.log(`${table}: ${rows.length} row(s)`);
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const chunk = rows.slice(i, i + BATCH_ROWS);
      for (const row of chunk) {
        const values = cols.map((c) => sqlLiteral(row[c])).join(", ");
        parts.push(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${values});`);
      }
    }
  }

  parts.push("UPDATE jobs SET status = 'pending' WHERE status = 'running';");
  parts.push("PRAGMA foreign_keys = ON;");

  fs.writeFileSync(sqlPath, parts.join("\n") + "\n", "utf8");
  console.log(`Wrote ${sqlPath} (${parts.length} statements)`);

  const wranglerArgs = ["wrangler", "d1", "execute", "cointrace", "--file", sqlPath];
  if (isLocal) wranglerArgs.push("--local");
  else wranglerArgs.push("--remote");

  console.log(`Running: npx ${wranglerArgs.join(" ")}`);
  const result = spawnSync("npx", wranglerArgs, { stdio: "inherit", shell: true });
  process.exit(result.status ?? 1);
}

main();
