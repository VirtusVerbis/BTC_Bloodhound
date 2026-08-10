import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JOB_PRIORITY, normalizeBitcoinAddress } from "@cointrace/core";
import type { AddHackerResult, ClearQueueResult, RemoveHackerResult } from "@cointrace/core";
import type { AppConfig, ListQueueOptions, ListQueueResult } from "@cointrace/core";
import { listQueue } from "@cointrace/core";
import { asReadOnlyStore } from "./remoteReadStore.js";

export interface D1WranglerClientOptions {
  remote: boolean;
  databaseName?: string;
  env?: string;
}

/** Escape a validated string for SQL string literals. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type Row = Record<string, unknown>;

export function npxExecutable(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** Quote one argv token for a Windows shell command line. */
export function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/g.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnWrangler(args: string[]) {
  if (process.platform === "win32") {
    const command = ["npx", ...args].map(quoteWindowsArg).join(" ");
    return spawnSync(command, {
      encoding: "utf8",
      shell: true,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return spawnSync(npxExecutable(), args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Strip trailing semicolons so Windows cmd does not treat them as command separators. */
export function normalizeWindowsCommandSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/g, "");
}

function parseWranglerStdout(out: string): unknown {
  const trimmed = out.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    return trimmed;
  }
}

function parseWranglerJsonOutput(result: SpawnSyncReturns<string>, failureLabel: string): unknown {
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute ${failureLabel} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return parseWranglerStdout(result.stdout || "");
}

/**
 * Thin Wrangler D1 client. SQL is always generated in-process from validated inputs.
 */
export class D1WranglerClient {
  readonly databaseName: string;
  readonly remote: boolean;
  readonly envName: string;

  constructor(opts: D1WranglerClientOptions) {
    this.databaseName = opts.databaseName ?? "cointrace";
    this.remote = opts.remote;
    this.envName = opts.env ?? "production";
  }

  private baseArgs(): string[] {
    const args = ["wrangler", "d1", "execute", this.databaseName, "--json"];
    if (this.remote) {
      args.push("--remote", "--env", this.envName);
    } else {
      args.push("--local");
    }
    return args;
  }

  execute(sql: string): unknown {
    if (process.platform === "win32") {
      const args = [...this.baseArgs(), "--command", normalizeWindowsCommandSql(sql)];
      return parseWranglerJsonOutput(spawnWrangler(args), "command");
    }
    const args = [...this.baseArgs(), "--command", sql];
    return parseWranglerJsonOutput(spawnWrangler(args), "command");
  }

  executeFile(filePath: string): unknown {
    const args = [...this.baseArgs(), "--file", filePath];
    return parseWranglerJsonOutput(spawnWrangler(args), "file");
  }

  query(sql: string): Row[] {
    return extractQueryRows(this.execute(sql));
  }
}

function extractQueryRows(parsed: unknown): Row[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object" && Array.isArray((item as { results?: unknown }).results)) {
        return (item as { results: Row[] }).results;
      }
      if (item && typeof item === "object" && Array.isArray((item as { rows?: unknown }).rows)) {
        return (item as { rows: Row[] }).rows;
      }
    }
    if (parsed.length > 0 && typeof parsed[0] === "object" && !("results" in (parsed[0] as object))) {
      return parsed as Row[];
    }
  }
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as { results?: Row[]; rows?: Row[] };
    if (Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj.rows)) return obj.rows;
  }
  return [];
}

function nowIso(): string {
  return new Date().toISOString();
}

function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

export async function addHackerRemote(
  client: D1WranglerClient,
  opts: { address: string; label?: string | null },
): Promise<AddHackerResult> {
  const address = normalizeBitcoinAddress(opts.address);
  if (!address) throw new Error(`Invalid Bitcoin address: ${opts.address}`);
  const a = sqlString(address);
  const ts = sqlString(nowIso());
  const labelSql = opts.label != null && opts.label !== "" ? sqlString(opts.label) : "NULL";

  client.execute(`
INSERT INTO addresses (
  address, role, label, source, is_flagged_hacker, created_at, first_seen_at, last_seen_at,
  hop_from_hacker, expand_status, total_received_sats
) VALUES (
  ${a}, 'hacker', ${labelSql}, 'ops', 1, ${ts}, ${ts}, ${ts}, 0, 'pending', 0
)
ON CONFLICT(address) DO UPDATE SET
  role = 'hacker',
  is_flagged_hacker = 1,
  hop_from_hacker = 0,
  source = 'ops',
  label = COALESCE(${labelSql}, addresses.label),
  last_seen_at = ${ts};
`);

  const pending = client.query(`
SELECT id FROM jobs
WHERE type = 'backfill_hacker_address'
  AND status IN ('pending', 'running')
  AND payload_json LIKE ${sqlString(`%"address":"${address}"%`)}
LIMIT 1;
`);
  let enqueuedBackfill = false;
  if (pending.length === 0) {
    const payload = sqlString(JSON.stringify({ address }));
    client.execute(`
INSERT INTO jobs (type, payload_json, status, priority, run_after, created_at)
VALUES ('backfill_hacker_address', ${payload}, 'pending', ${JOB_PRIORITY.BACKFILL_HACKER}, ${ts}, ${ts});
`);
    enqueuedBackfill = true;
  }

  return { address, upserted: true, enqueuedBackfill };
}

export async function clearQueueRemote(client: D1WranglerClient): Promise<ClearQueueResult> {
  const rows = client.query(
    "SELECT status, COUNT(*) AS c FROM jobs WHERE status IN ('pending','running') GROUP BY status;",
  );
  let pending = 0;
  let running = 0;
  for (const r of rows) {
    if (r.status === "pending") pending = Number(r.c ?? 0);
    if (r.status === "running") running = Number(r.c ?? 0);
  }
  client.execute("DELETE FROM jobs WHERE status IN ('pending', 'running');");
  return { deleted: pending + running, pending, running };
}

export async function listQueueRemote(
  client: D1WranglerClient,
  config: AppConfig,
  opts: ListQueueOptions = {},
): Promise<ListQueueResult> {
  return listQueue(asReadOnlyStore(client), config, opts);
}

export async function removeHackerRemote(
  client: D1WranglerClient,
  rawAddress: string,
  opts: { pruneExclusive?: boolean } = {},
): Promise<RemoveHackerResult> {
  const pruneExclusive = opts.pruneExclusive !== false;
  const address = normalizeBitcoinAddress(rawAddress);
  if (!address) throw new Error(`Invalid Bitcoin address: ${rawAddress}`);
  const a = sqlString(address);

  const addrRows = client.query(`SELECT * FROM addresses WHERE address = ${a} LIMIT 1;`);
  const existing = addrRows[0];
  if (!existing || !asBool(existing.is_flagged_hacker)) {
    return {
      address,
      unflagged: false,
      jobsCancelled: 0,
      victimsPruned: 0,
      downstreamPruned: 0,
      edgesRemoved: 0,
      message: "Address is not a flagged hacker (no-op)",
    };
  }

  const victims = pruneExclusive
    ? client
        .query(
          `SELECT DISTINCT from_address AS address FROM edges WHERE to_address = ${a} AND direction = 'in_to_hacker';`,
        )
        .map((r) => String(r.address))
    : [];

  const downstream = pruneExclusive ? collectDownstreamRemote(client, address) : [];
  const downstreamSet = new Set(downstream);

  const statements: string[] = ["PRAGMA foreign_keys = OFF;"];

  statements.push(`UPDATE addresses SET is_flagged_hacker = 0, last_seen_at = ${sqlString(nowIso())} WHERE address = ${a};`);

  const jobRows = client.query(`
SELECT id FROM jobs
WHERE status IN ('pending', 'running')
  AND payload_json LIKE ${sqlString(`%"address":"${address}"%`)};
`);
  const jobsCancelled = jobRows.length;
  for (const j of jobRows) {
    statements.push(`DELETE FROM jobs WHERE id = ${Number(j.id)};`);
  }

  let victimsPruned = 0;
  let downstreamPruned = 0;
  let edgesRemoved = 0;

  if (pruneExclusive) {
    const hackerEdgeCount = client.query(
      `SELECT COUNT(*) AS c FROM edges WHERE from_address = ${a} OR to_address = ${a};`,
    );
    edgesRemoved += Number(hackerEdgeCount[0]?.c ?? 0);
    statements.push(`DELETE FROM edges WHERE from_address = ${a} OR to_address = ${a};`);

    const pruned = new Set<string>();

    for (const victim of victims) {
      if (victim === address || pruned.has(victim)) continue;
      const v = sqlString(victim);
      const otherLinks = client.query(`
SELECT COUNT(*) AS c FROM edges e
INNER JOIN addresses addr ON addr.address = e.to_address
WHERE e.from_address = ${v}
  AND e.direction = 'in_to_hacker'
  AND addr.is_flagged_hacker = 1
  AND e.to_address != ${a};
`);
      if (Number(otherLinks[0]?.c ?? 0) > 0) continue;
      const row = client.query(`SELECT is_flagged_hacker FROM addresses WHERE address = ${v} LIMIT 1;`);
      if (!row[0] || asBool(row[0].is_flagged_hacker)) continue;

      const ec = client.query(
        `SELECT COUNT(*) AS c FROM edges WHERE from_address = ${v} OR to_address = ${v};`,
      );
      edgesRemoved += Number(ec[0]?.c ?? 0);
      statements.push(`DELETE FROM edges WHERE from_address = ${v} OR to_address = ${v};`);
      statements.push(`DELETE FROM sync_state WHERE address = ${v};`);
      statements.push(`DELETE FROM addresses WHERE address = ${v};`);
      pruned.add(victim);
      victimsPruned += 1;
    }

    for (const candidate of downstream) {
      if (candidate === address || pruned.has(candidate)) continue;
      const c = sqlString(candidate);
      const row = client.query(`SELECT is_flagged_hacker FROM addresses WHERE address = ${c} LIMIT 1;`);
      if (!row[0]) continue;
      if (asBool(row[0].is_flagged_hacker)) continue;

      if (hasEdgeWithOtherFlaggedRemote(client, candidate, address)) continue;
      if (hasOutFromOutsideRemote(client, candidate, downstreamSet, address)) continue;

      const ec = client.query(
        `SELECT COUNT(*) AS c FROM edges WHERE from_address = ${c} OR to_address = ${c};`,
      );
      edgesRemoved += Number(ec[0]?.c ?? 0);
      statements.push(`DELETE FROM edges WHERE from_address = ${c} OR to_address = ${c};`);
      statements.push(`DELETE FROM sync_state WHERE address = ${c};`);
      statements.push(`DELETE FROM addresses WHERE address = ${c};`);
      pruned.add(candidate);
      downstreamPruned += 1;
    }
  }

  statements.push("PRAGMA foreign_keys = ON;");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cointrace-ops-"));
  try {
    const filePath = path.join(tmpDir, "remove.sql");
    fs.writeFileSync(filePath, statements.join("\n") + "\n", "utf8");
    client.executeFile(filePath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    address,
    unflagged: true,
    jobsCancelled,
    victimsPruned,
    downstreamPruned,
    edgesRemoved,
  };
}

function collectDownstreamRemote(client: D1WranglerClient, hacker: string): string[] {
  const seen = new Set<string>([hacker]);
  const queue = [hacker];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const outs = client.query(
      `SELECT to_address AS toAddr FROM edges WHERE from_address = ${sqlString(cur)} AND direction = 'out_from_hacker';`,
    );
    for (const row of outs) {
      const to = String(row.toAddr);
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  seen.delete(hacker);
  return [...seen];
}

function hasEdgeWithOtherFlaggedRemote(
  client: D1WranglerClient,
  address: string,
  excludeHacker: string,
): boolean {
  const a = sqlString(address);
  const ex = sqlString(excludeHacker);
  const rows = client.query(`
SELECT 1 AS ok FROM edges e
WHERE (e.from_address = ${a} OR e.to_address = ${a})
  AND (
    (e.from_address = ${a} AND e.to_address IN (SELECT address FROM addresses WHERE is_flagged_hacker = 1 AND address != ${ex} AND address != ${a}))
    OR
    (e.to_address = ${a} AND e.from_address IN (SELECT address FROM addresses WHERE is_flagged_hacker = 1 AND address != ${ex} AND address != ${a}))
  )
LIMIT 1;
`);
  return rows.length > 0;
}

function hasOutFromOutsideRemote(
  client: D1WranglerClient,
  address: string,
  candidateSet: Set<string>,
  excludeHacker: string,
): boolean {
  const rows = client.query(
    `SELECT from_address AS frm FROM edges WHERE to_address = ${sqlString(address)} AND direction = 'out_from_hacker';`,
  );
  return rows.some((r) => {
    const from = String(r.frm);
    return from !== excludeHacker && !candidateSet.has(from);
  });
}
