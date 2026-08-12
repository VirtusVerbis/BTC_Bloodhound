import type { Store } from "@cointrace/db";
import type { Job } from "@cointrace/db";
import { D1WranglerClient, sqlString } from "./d1Wrangler.js";

type Row = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function mapJobRow(row: Row): Job {
  return {
    id: num(row.id),
    type: str(row.type),
    payloadJson: str(row.payload_json),
    status: str(row.status),
    priority: num(row.priority),
    runAfter: str(row.run_after),
    attempts: num(row.attempts),
    lastError: row.last_error != null ? str(row.last_error) : null,
    createdAt: str(row.created_at),
    startedAt: row.started_at != null ? str(row.started_at) : null,
    completedAt: row.completed_at != null ? str(row.completed_at) : null,
  };
}

function mapAddressRow(row: Row | undefined) {
  if (!row) return undefined;
  return {
    address: str(row.address),
    role: str(row.role),
    label: row.label != null ? str(row.label) : null,
    source: str(row.source),
    isFlaggedHacker: row.is_flagged_hacker === 1 || row.is_flagged_hacker === true,
    notes: row.notes != null ? str(row.notes) : null,
    firstSeenAt: row.first_seen_at != null ? str(row.first_seen_at) : null,
    lastSeenAt: row.last_seen_at != null ? str(row.last_seen_at) : null,
    createdAt: str(row.created_at),
    hopFromHacker: row.hop_from_hacker != null ? num(row.hop_from_hacker) : null,
    expandStatus: str(row.expand_status),
    lastExpandedAt: row.last_expanded_at != null ? str(row.last_expanded_at) : null,
    totalReceivedSats: num(row.total_received_sats),
    liveBalanceSats: row.live_balance_sats != null ? num(row.live_balance_sats) : null,
    liveBalanceAt: row.live_balance_at != null ? str(row.live_balance_at) : null,
  };
}

function statusClause(statuses: string[]): string {
  return statuses.map((s) => sqlString(s)).join(", ");
}

/**
 * Read-only Store adapter for wrangler D1 execute (remote ops CLI).
 */
export class RemoteReadStore {
  constructor(private readonly client: D1WranglerClient) {}

  async getActiveJobSummary(filters?: { statuses?: string[]; type?: string }) {
    const statuses = filters?.statuses ?? ["pending", "running"];
    let sql = `SELECT status, type, COUNT(*) AS count FROM jobs WHERE status IN (${statusClause(statuses)})`;
    if (filters?.type) sql += ` AND type = ${sqlString(filters.type)}`;
    sql += " GROUP BY status, type;";
    return this.client.query(sql);
  }

  async countActiveJobsMatching(filters?: { statuses?: string[]; type?: string }) {
    const statuses = filters?.statuses ?? ["pending", "running"];
    let sql = `SELECT COUNT(*) AS count FROM jobs WHERE status IN (${statusClause(statuses)})`;
    if (filters?.type) sql += ` AND type = ${sqlString(filters.type)}`;
    sql += ";";
    const row = this.client.query(sql)[0];
    return num(row?.count);
  }

  async listActiveJobs(opts?: { statuses?: string[]; type?: string; limit?: number; offset?: number }) {
    const statuses = opts?.statuses ?? ["pending", "running"];
    let sql = `SELECT * FROM jobs WHERE status IN (${statusClause(statuses)})`;
    if (opts?.type) sql += ` AND type = ${sqlString(opts.type)}`;
    sql += " ORDER BY priority DESC, run_after ASC";
    if (opts?.limit != null) sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    if (opts?.offset != null) sql += ` OFFSET ${Math.max(0, Math.floor(opts.offset))}`;
    sql += ";";
    return this.client.query(sql).map(mapJobRow);
  }

  async getQueueDepth() {
    const row = this.client.query("SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending';")[0];
    return num(row?.count);
  }

  async countActiveJobs(type: string) {
    const row = this.client.query(
      `SELECT COUNT(*) AS count FROM jobs WHERE type = ${sqlString(type)} AND status IN ('pending', 'running');`,
    )[0];
    return num(row?.count);
  }

  async hasPendingJob(type: string, address?: string) {
    let sql = `SELECT 1 AS ok FROM jobs WHERE type = ${sqlString(type)} AND status IN ('pending', 'running')`;
    if (address) {
      sql += ` AND json_extract(payload_json, '$.address') = ${sqlString(address)}`;
    }
    sql += " LIMIT 1;";
    return this.client.query(sql).length > 0;
  }

  async getSchedulerState() {
    const row = this.client.query("SELECT * FROM scheduler_state WHERE id = 1 LIMIT 1;")[0];
    if (!row) return undefined;
    return {
      id: num(row.id, 1),
      nextProviderCallAt: row.next_provider_call_at != null ? str(row.next_provider_call_at) : null,
      lastProviderUsed: row.last_provider_used != null ? str(row.last_provider_used) : null,
      lastProviderSuccessAt:
        row.last_provider_success_at != null ? str(row.last_provider_success_at) : null,
      lastApiThresholdAt: row.last_api_threshold_at != null ? str(row.last_api_threshold_at) : null,
      apiThresholdCount: num(row.api_threshold_count),
      lastEsploraThresholdAt:
        row.last_esplora_threshold_at != null ? str(row.last_esplora_threshold_at) : null,
      lastMempoolThresholdAt:
        row.last_mempool_threshold_at != null ? str(row.last_mempool_threshold_at) : null,
      esploraThresholdCount: num(row.esplora_threshold_count),
      mempoolThresholdCount: num(row.mempool_threshold_count),
      esploraStrikeCount: num(row.esplora_strike_count),
      mempoolStrikeCount: num(row.mempool_strike_count),
      esploraRetryAfterAt: row.esplora_retry_after_at != null ? str(row.esplora_retry_after_at) : null,
      mempoolRetryAfterAt: row.mempool_retry_after_at != null ? str(row.mempool_retry_after_at) : null,
      queueSchedulingPaused: num(row.queue_scheduling_paused),
      backfillHealAuditIndex: num(row.backfill_heal_audit_index),
      hackerPollIndex: num(row.hacker_poll_index),
      maintenanceCronCounter: num(row.maintenance_cron_counter),
      rateLimitMs: row.rate_limit_ms != null ? num(row.rate_limit_ms) : null,
      btcUsdPrice: row.btc_usd_price != null ? num(row.btc_usd_price) : null,
      btcUsdPriceAt: row.btc_usd_price_at != null ? str(row.btc_usd_price_at) : null,
    };
  }

  async getCrawlStats() {
    const pending = this.client.query(
      "SELECT COUNT(*) AS count FROM addresses WHERE expand_status = 'pending' AND (role = 'downstream' OR role = 'hacker');",
    )[0];
    const expanded = this.client.query(
      "SELECT COUNT(*) AS count FROM addresses WHERE expand_status = 'expanded';",
    )[0];
    const maxHop = this.client.query(
      "SELECT MAX(hop_from_hacker) AS max FROM addresses WHERE role = 'downstream';",
    )[0];
    return {
      crawlPendingCount: num(pending?.count),
      crawlExpandedCount: num(expanded?.count),
      crawlMaxHopReached: num(maxHop?.max),
    };
  }

  async countDownstreamTreeNodes(maxDepth: number) {
    const row = this.client.query(
      `SELECT COUNT(*) AS count FROM addresses WHERE role = 'downstream' AND hop_from_hacker < ${Math.floor(maxDepth)};`,
    )[0];
    return num(row?.count);
  }

  async countDownstreamPollDue(maxDepth: number, minIntervalSec: number) {
    const cutoff = sqlString(new Date(Date.now() - minIntervalSec * 1000).toISOString());
    const row = this.client.query(`
SELECT COUNT(*) AS count
FROM addresses
LEFT JOIN sync_state ON addresses.address = sync_state.address
WHERE addresses.role = 'downstream'
  AND (addresses.expand_status = 'expanded' OR addresses.expand_status = 'pending')
  AND addresses.hop_from_hacker < ${Math.floor(maxDepth)}
  AND (sync_state.last_polled_at IS NULL OR sync_state.last_polled_at <= ${cutoff});
`)[0];
    return num(row?.count);
  }

  async getDownstreamMonitorStats(maxDepth: number, minIntervalSec: number) {
    return {
      treeNodeCount: await this.countDownstreamTreeNodes(maxDepth),
      downstreamPollDueCount: await this.countDownstreamPollDue(maxDepth, minIntervalSec),
    };
  }

  async getSourceSync(source: string) {
    const row = this.client.query(
      `SELECT * FROM source_sync_state WHERE source = ${sqlString(source)} LIMIT 1;`,
    )[0];
    if (!row) return undefined;
    return {
      source: str(row.source),
      lastSyncAt: row.last_sync_at != null ? str(row.last_sync_at) : null,
      lastAddressCount: row.last_address_count != null ? num(row.last_address_count) : null,
      lastContentHash: row.last_content_hash != null ? str(row.last_content_hash) : null,
    };
  }

  async getHackerPollIndex() {
    return (await this.getSchedulerState())?.hackerPollIndex ?? 0;
  }

  async listHackers() {
    return this.client
      .query(
        "SELECT * FROM addresses WHERE is_flagged_hacker = 1 ORDER BY total_received_sats DESC;",
      )
      .map((row) => mapAddressRow(row)!);
  }

  async getAddress(address: string) {
    const row = this.client.query(
      `SELECT * FROM addresses WHERE address = ${sqlString(address)} LIMIT 1;`,
    )[0];
    return mapAddressRow(row);
  }

  async getSyncState(address: string) {
    const row = this.client.query(
      `SELECT * FROM sync_state WHERE address = ${sqlString(address)} LIMIT 1;`,
    )[0];
    if (!row) return undefined;
    return {
      address: str(row.address),
      lastSeenTxid: row.last_seen_txid != null ? str(row.last_seen_txid) : null,
      lastBlockHeight: row.last_block_height != null ? num(row.last_block_height) : null,
      lastPolledAt: row.last_polled_at != null ? str(row.last_polled_at) : null,
      backfillStateJson: row.backfill_state_json != null ? str(row.backfill_state_json) : null,
      backfillComplete: row.backfill_complete === 1 || row.backfill_complete === true,
      lastBackfillAuditAt:
        row.last_backfill_audit_at != null ? str(row.last_backfill_audit_at) : null,
      chainTxCountAtAudit:
        row.chain_tx_count_at_audit != null ? num(row.chain_tx_count_at_audit) : null,
    };
  }

  async getBackfillState(address: string) {
    const row = await this.getSyncState(address);
    if (!row) return null;
    let payload: Record<string, unknown> | null = null;
    if (row.backfillStateJson) {
      try {
        payload = JSON.parse(row.backfillStateJson) as Record<string, unknown>;
      } catch {
        payload = null;
      }
    }
    return {
      payload,
      backfillComplete: row.backfillComplete,
      lastBackfillAuditAt: row.lastBackfillAuditAt ?? null,
      chainTxCountAtAudit: row.chainTxCountAtAudit ?? null,
    };
  }

  async getDownstreamFrontier(limit: number, maxDepth: number) {
    return this.client
      .query(`
SELECT address FROM addresses
WHERE (role = 'downstream' OR role = 'hacker')
  AND expand_status = 'pending'
  AND hop_from_hacker < ${Math.floor(maxDepth)}
ORDER BY hop_from_hacker ASC, last_seen_at ASC
LIMIT ${Math.max(0, Math.floor(limit))};
`)
      .map((row) => ({ address: str(row.address) }));
  }

  async listDownstreamForPoll(limit: number, maxDepth: number, minIntervalSec: number) {
    const cutoff = sqlString(new Date(Date.now() - minIntervalSec * 1000).toISOString());
    return this.client
      .query(`
SELECT addresses.address AS address
FROM addresses
LEFT JOIN sync_state ON addresses.address = sync_state.address
WHERE addresses.role = 'downstream'
  AND (addresses.expand_status = 'expanded' OR addresses.expand_status = 'pending')
  AND addresses.hop_from_hacker < ${Math.floor(maxDepth)}
  AND (sync_state.last_polled_at IS NULL OR sync_state.last_polled_at <= ${cutoff})
ORDER BY sync_state.last_polled_at ASC, addresses.hop_from_hacker ASC
LIMIT ${Math.max(0, Math.floor(limit))};
`)
      .map((row) => ({ address: str(row.address) }));
  }
}

export function asReadOnlyStore(client: D1WranglerClient): Store {
  return new RemoteReadStore(client) as unknown as Store;
}
