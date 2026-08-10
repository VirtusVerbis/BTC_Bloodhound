#!/usr/bin/env node
/**
 * Pull Cloudflare D1 into local SQLite.
 *
 * Phase A — wrangler d1 export (all-or-nothing; no resume).
 * Phase B — SQL → SQLite import (resumable with checkpoint + live progress %).
 *
 * Usage:
 *   node scripts/d1-to-sqlite.mjs [--remote|--local] [--db path] [--sql path] [--skip-export]
 *
 * Resume import: re-run with the same --sql file (or default path); continues from checkpoint.
 * If Phase A was interrupted, delete the partial SQL file and re-export (do not --skip-export).
 *
 * WARNING: replaces local SQLite contents for imported tables.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { computeProgressPct, nextImportIndex, splitSqlStatements } from "./db-sync-helpers.mjs";

const args = process.argv.slice(2);
const isLocal = args.includes("--local");
const isRemote = args.includes("--remote") || (!isLocal && !args.includes("--local"));
const skipExport = args.includes("--skip-export");
const dbIdx = args.indexOf("--db");
const sqlIdx = args.indexOf("--sql");
const dbPath = path.resolve(
  dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : "data/cointrace.db",
);
const outDir = path.resolve(".wrangler/tmp");
fs.mkdirSync(outDir, { recursive: true });
const defaultSql = path.join(
  outDir,
  isRemote ? "d1-export-remote.sql" : "d1-export-local.sql",
);
const sqlPath = path.resolve(sqlIdx >= 0 && args[sqlIdx + 1] ? args[sqlIdx + 1] : defaultSql);

const DATA_TABLES = [
  "addresses",
  "edges",
  "transactions",
  "sync_state",
  "jobs",
  "source_sync_state",
  "scheduler_state",
  "rate_limits",
];

function writeProgress(pct, stmt, total) {
  process.stdout.write(`\rImport ${pct}% (stmt ${stmt}/${total})`.padEnd(60));
}

function exportD1(outputPath, remote) {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  const wranglerArgs = ["wrangler", "d1", "export", "cointrace", "--output", outputPath];
  if (remote) wranglerArgs.push("--remote", "--env", "production");
  else wranglerArgs.push("--local");
  console.log(`Exporting D1 (${remote ? "remote" : "local"})…`);
  const result = spawnSync("npx", wranglerArgs, { encoding: "utf8", shell: true, stdio: "inherit" });
  if (result.status !== 0) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.error("D1 export failed (all-or-nothing). Delete any partial file and retry.");
    process.exit(result.status ?? 1);
  }
  if (!fs.existsSync(outputPath)) {
    console.error("Export reported success but output file is missing.");
    process.exit(1);
  }
}

function ensureMigratedSchema(sqlite) {
  // Prefer applying repo migrations via better-sqlite3 if migrate SQL exists.
  const migDir = path.resolve("migrations");
  if (!fs.existsSync(migDir)) return;
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), "utf8");
    try {
      sqlite.exec(sql);
    } catch {
      /* already applied */
    }
  }
}

function main() {
  if (!skipExport) {
    exportD1(sqlPath, isRemote);
  } else if (!fs.existsSync(sqlPath)) {
    console.error(`--skip-export set but SQL file missing: ${sqlPath}`);
    process.exit(1);
  }

  const fp = crypto.createHash("sha256").update(sqlPath).digest("hex").slice(0, 16);
  const manifestPath = path.join(outDir, `pull-import-checkpoint-${fp}.json`);
  /** @type {{ nextIndex: number, prepared: boolean }} */
  let manifest = { nextIndex: 0, prepared: false };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
    } catch {
      /* fresh */
    }
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  if (!manifest.prepared) {
    ensureMigratedSchema(sqlite);
    sqlite.exec("PRAGMA foreign_keys = OFF;");
    for (const t of [...DATA_TABLES].reverse()) {
      try {
        sqlite.exec(`DELETE FROM ${t};`);
      } catch {
        /* table may not exist yet */
      }
    }
    manifest.prepared = true;
    manifest.nextIndex = 0;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  const raw = fs.readFileSync(sqlPath, "utf8");
  const statements = splitSqlStatements(raw).map((s) => s.trim()).filter(Boolean);
  // Skip schema DDL when we already migrated; still apply INSERT/UPDATE/DELETE/CREATE IF needed.
  const actionable = statements.filter((s) => {
    const u = s.toUpperCase();
    if (u.startsWith("CREATE TABLE")) return false;
    if (u.startsWith("CREATE INDEX")) return false;
    if (u.startsWith("CREATE UNIQUE")) return false;
    return true;
  });

  const total = actionable.length;
  let i = nextImportIndex(manifest.nextIndex ?? 0, total);

  try {
    sqlite.exec("PRAGMA foreign_keys = OFF;");
    const run = sqlite.transaction((from, to) => {
      for (let j = from; j < to; j++) {
        const stmt = actionable[j];
        try {
          sqlite.exec(stmt);
        } catch (err) {
          // Ignore benign schema leftovers
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists|duplicate column/i.test(msg)) throw err;
        }
      }
    });

    const CHUNK = 200;
    while (i < total) {
      const end = Math.min(i + CHUNK, total);
      run(i, end);
      i = end;
      manifest.nextIndex = i;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      writeProgress(computeProgressPct(i, total), i, total);
    }

    sqlite.exec("UPDATE jobs SET status = 'pending' WHERE status = 'running';");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    process.stdout.write("\n");
    console.log(`Import complete into ${dbPath}`);
    fs.rmSync(manifestPath, { force: true });
  } catch (err) {
    process.stdout.write("\n");
    console.error(`Import failed at stmt ${i}/${total}. Re-run with --skip-export to resume.`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    sqlite.close();
  }
}

main();
