import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const addresses = sqliteTable("addresses", {
  address: text("address").primaryKey(),
  role: text("role").notNull().default("unknown"),
  label: text("label"),
  source: text("source").notNull().default("derived"),
  isFlaggedHacker: integer("is_flagged_hacker", { mode: "boolean" }).notNull().default(false),
  notes: text("notes"),
  firstSeenAt: text("first_seen_at"),
  lastSeenAt: text("last_seen_at"),
  createdAt: text("created_at").notNull(),
  hopFromHacker: integer("hop_from_hacker"),
  expandStatus: text("expand_status").notNull().default("pending"),
  lastExpandedAt: text("last_expanded_at"),
  expandProfile: text("expand_profile"),
  relayMetaJson: text("relay_meta_json"),
  fanoutMetaJson: text("fanout_meta_json"),
  totalReceivedSats: integer("total_received_sats").notNull().default(0),
  liveBalanceSats: integer("live_balance_sats"),
  liveBalanceAt: text("live_balance_at"),
  lastGraphActivityAt: text("last_graph_activity_at"),
});

export const edges = sqliteTable(
  "edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    txid: text("txid").notNull(),
    amountSats: integer("amount_sats").notNull(),
    blockTime: text("block_time"),
    hopFromHacker: integer("hop_from_hacker"),
    direction: text("direction").notNull(),
    edgeKind: text("edge_kind"),
    fanoutMetaJson: text("fanout_meta_json"),
  },
  (table) => [uniqueIndex("edges_from_to_txid_uq").on(table.fromAddress, table.toAddress, table.txid)],
);

export const transactions = sqliteTable("transactions", {
  txid: text("txid").primaryKey(),
  blockHeight: integer("block_height"),
  blockTime: text("block_time"),
  feeSats: integer("fee_sats"),
  opReturnDisplay: text("op_return_display"),
});

export const syncState = sqliteTable("sync_state", {
  address: text("address").primaryKey(),
  lastSeenTxid: text("last_seen_txid"),
  lastBlockHeight: integer("last_block_height"),
  lastPolledAt: text("last_polled_at"),
  backfillStateJson: text("backfill_state_json"),
  backfillComplete: integer("backfill_complete").notNull().default(0),
  lastBackfillAuditAt: text("last_backfill_audit_at"),
  chainTxCountAtAudit: integer("chain_tx_count_at_audit"),
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  priority: integer("priority").notNull().default(1),
  runAfter: text("run_after").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  reclaimCount: integer("reclaim_count").notNull().default(0),
  reclaimProgressJson: text("reclaim_progress_json"),
});

export const sourceSyncState = sqliteTable("source_sync_state", {
  source: text("source").primaryKey(),
  lastSyncAt: text("last_sync_at"),
  lastAddressCount: integer("last_address_count"),
  lastContentHash: text("last_content_hash"),
});

export const schedulerState = sqliteTable("scheduler_state", {
  id: integer("id").primaryKey().default(1),
  nextProviderCallAt: text("next_provider_call_at"),
  lastProviderUsed: text("last_provider_used"),
  lastProviderSuccessAt: text("last_provider_success_at"),
  lastApiThresholdAt: text("last_api_threshold_at"),
  apiThresholdCount: integer("api_threshold_count").notNull().default(0),
  lastEsploraThresholdAt: text("last_esplora_threshold_at"),
  lastMempoolThresholdAt: text("last_mempool_threshold_at"),
  esploraThresholdCount: integer("esplora_threshold_count").notNull().default(0),
  mempoolThresholdCount: integer("mempool_threshold_count").notNull().default(0),
  esploraStrikeCount: integer("esplora_strike_count").notNull().default(0),
  mempoolStrikeCount: integer("mempool_strike_count").notNull().default(0),
  esploraRetryAfterAt: text("esplora_retry_after_at"),
  mempoolRetryAfterAt: text("mempool_retry_after_at"),
  queueSchedulingPaused: integer("queue_scheduling_paused").notNull().default(0),
  backfillHealAuditIndex: integer("backfill_heal_audit_index").notNull().default(0),
  hackerPollIndex: integer("hacker_poll_index").notNull().default(0),
  maintenanceCronCounter: integer("maintenance_cron_counter").notNull().default(0),
  rateLimitMs: integer("rate_limit_ms").notNull().default(3000),
  btcUsdPrice: integer("btc_usd_price"),
  btcUsdPriceAt: text("btc_usd_price_at"),
  btcUsdRefreshAttemptAt: text("btc_usd_refresh_attempt_at"),
  tickLeaseUntil: text("tick_lease_until"),
  d1ReadRetryAfterAt: text("d1_read_retry_after_at"),
  d1WriteRetryAfterAt: text("d1_write_retry_after_at"),
  recentHackersJson: text("recent_hackers_json"),
  cronIndexerPaused: integer("cron_indexer_paused").notNull().default(0),
  quotaDayUtc: text("quota_day_utc"),
  d1RowsReadTotal: integer("d1_rows_read_total").notNull().default(0),
  d1RowsWrittenTotal: integer("d1_rows_written_total").notNull().default(0),
  workersRequestsTotal: integer("workers_requests_total").notNull().default(0),
  d1RowsReadCron: integer("d1_rows_read_cron").notNull().default(0),
  d1RowsWrittenCron: integer("d1_rows_written_cron").notNull().default(0),
  workersRequestsCron: integer("workers_requests_cron").notNull().default(0),
});

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: text("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

export type Address = typeof addresses.$inferSelect;
export type Edge = typeof edges.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
