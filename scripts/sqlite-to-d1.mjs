#!/usr/bin/env node
/**
 * Export local SQLite data and import into Cloudflare D1 (local or remote).
 *
 * Batched, resumable push with live progress %.
 *
 * Usage:
 *   node scripts/sqlite-to-d1.mjs [--local|--remote] [--db path] [--clear]
 *
 * Resume: re-run the same command; completed batches in the checkpoint are skipped.
 * Prefer avoiding --clear on resume. If --clear is passed, deletes run once and are
 * recorded in the manifest; an interrupted clear+push may need --clear again or manual repair.
 *
 * Prerequisites:
 *   - Checkpoint local DB (pause writers, PRAGMA wal_checkpoint(FULL))
 *   - Apply D1 migrations first: pnpm db:d1:migrate [--local] / :remote
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { computeProgressPct } from "./db-sync-helpers.mjs";

const args = process.argv.slice(2);
const isLocal = args.includes("--local");
const isRemote = args.includes("--remote");
const clear = args.includes("--clear");
const dbIdx = args.indexOf("--db");
const dbPath = path.resolve(
  dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : "data/cointrace.db",
);

if (!isLocal && !isRemote) {
  console.error("Specify --local or --remote");
  process.exit(1);
}

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

function fingerprint(dbPathResolved, clearFlag, remote) {
  return crypto
    .createHash("sha256")
    .update(`${dbPathResolved}|clear=${clearFlag ? 1 : 0}|remote=${remote ? 1 : 0}`)
    .digest("hex")
    .slice(0, 16);
}

function writeProgress(batch, total) {
  const line = `Push ${computeProgressPct(batch, total)}% (batch ${batch}/${total})`;
  process.stdout.write(`\r${line.padEnd(60)}`);
}

function runWranglerFile(sqlPath, remote) {
  const wranglerArgs = ["wrangler", "d1", "execute", "cointrace", "--file", sqlPath];
  if (remote) wranglerArgs.push("--remote", "--env", "production");
  else wranglerArgs.push("--local");
  const result = spawnSync("npx", wranglerArgs, {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `wrangler exit ${result.status}`);
  }
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`Local DB not found: ${dbPath}`);
    process.exit(1);
  }

  const outDir = path.resolve(".wrangler/tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const fp = fingerprint(dbPath, clear, isRemote);
  const manifestPath = path.join(outDir, `push-checkpoint-${fp}.json`);
  const batchesDir = path.join(outDir, `push-batches-${fp}`);
  fs.mkdirSync(batchesDir, { recursive: true });

  /** @type {{ clearDone: boolean, completed: string[], totalBatches: number, finalized: boolean }} */
  let manifest = {
    clearDone: false,
    completed: [],
    totalBatches: 0,
    finalized: false,
  };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
    } catch {
      /* fresh */
    }
  }
  const completed = new Set(manifest.completed ?? []);

  const sqlite = new Database(dbPath, { readonly: true });

  /** @type {{ id: string, file: string }[]} */
  const batches = [];

  if (clear && !manifest.clearDone) {
    const clearParts = ["PRAGMA foreign_keys = OFF;"];
    for (const t of [...TABLES].reverse()) {
      clearParts.push(`DELETE FROM ${t};`);
    }
    clearParts.push("PRAGMA foreign_keys = ON;");
    const clearFile = path.join(batchesDir, "00-clear.sql");
    fs.writeFileSync(clearFile, clearParts.join("\n") + "\n", "utf8");
    batches.push({ id: "clear", file: clearFile });
  }

  let batchIndex = 0;
  for (const table of TABLES) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (cols.length === 0) continue;
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const chunk = rows.slice(i, i + BATCH_ROWS);
      const parts = ["PRAGMA foreign_keys = OFF;"];
      for (const row of chunk) {
        const values = cols.map((c) => sqlLiteral(row[c])).join(", ");
        parts.push(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${values});`);
      }
      parts.push("PRAGMA foreign_keys = ON;");
      const id = `${table}-${i}`;
      const file = path.join(batchesDir, `${String(++batchIndex).padStart(4, "0")}-${id}.sql`);
      fs.writeFileSync(file, parts.join("\n") + "\n", "utf8");
      batches.push({ id, file });
    }
  }

  const finalId = "finalize";
  const finalFile = path.join(batchesDir, "zzzz-finalize.sql");
  fs.writeFileSync(
    finalFile,
    "UPDATE jobs SET status = 'pending' WHERE status = 'running';\n",
    "utf8",
  );
  batches.push({ id: finalId, file: finalFile });

  manifest.totalBatches = batches.length;
  const saveManifest = () => {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  };
  saveManifest();

  const total = batches.length;
  let done = [...completed].filter((id) => batches.some((b) => b.id === id)).length;

  try {
    for (const batch of batches) {
      if (completed.has(batch.id)) {
        done = Math.max(done, [...completed].length);
        writeProgress(done, total);
        continue;
      }
      runWranglerFile(batch.file, isRemote);
      completed.add(batch.id);
      manifest.completed = [...completed];
      if (batch.id === "clear") manifest.clearDone = true;
      if (batch.id === finalId) manifest.finalized = true;
      saveManifest();
      done += 1;
      writeProgress(done, total);
    }
    process.stdout.write("\n");
    console.log(`Push complete (${total} batches). Checkpoint: ${manifestPath}`);
    // Successful full run — drop checkpoint so next full push starts clean.
    fs.rmSync(manifestPath, { force: true });
  } catch (err) {
    process.stdout.write("\n");
    console.error(`Push failed after ${done}/${total} batches. Re-run to resume from checkpoint.`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    sqlite.close();
  }
}

main();
