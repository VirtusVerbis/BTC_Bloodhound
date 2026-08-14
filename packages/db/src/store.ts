import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { D1Binding } from "./d1.js";
import * as schema from "./schema.js";
import {
  addresses,
  edges,
  jobs,
  rateLimits,
  schedulerState,
  sourceSyncState,
  syncState,
  transactions,
  type Job,
  type Transaction,
} from "./schema.js";

const INGEST_JOB_TYPES = [
  "backfill_hacker_address",
  "audit_hacker_backfill",
  "expand_downstream",
] as const;

const TXID_BATCH_SIZE = 200;
const ADDRESS_DETAIL_TX_LIMIT = 50;

function jobPayloadAddressEq(address: string) {
  return sql`json_extract(${jobs.payloadJson}, '$.address') = ${address}`;
}

function extractIngestProgressSnapshot(payloadJson: string): {
  processedIndex: number;
  headTxid: string | null;
  chainCursor: string | null;
} {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return { processedIndex: 0, headTxid: null, chainCursor: null };
  }

  const processedIndex = typeof payload.processedIndex === "number" ? payload.processedIndex : 0;
  let headTxid: string | null = null;
  const pendingTxs = payload.pendingTxs;
  if (Array.isArray(pendingTxs) && pendingTxs.length > processedIndex) {
    const entry = pendingTxs[processedIndex] as { txid?: string };
    headTxid = entry?.txid ?? null;
  } else {
    const pendingTxids = payload.pendingTxids;
    if (Array.isArray(pendingTxids) && pendingTxids.length > processedIndex) {
      headTxid = String(pendingTxids[processedIndex]);
    }
  }
  const chainCursor =
    payload.chainCursor != null && payload.chainCursor !== "" ? String(payload.chainCursor) : null;
  return { processedIndex, headTxid, chainCursor };
}

function isIngestContinuation(payloadJson: string): boolean {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return false;
  }

  if (payload.chainCursor != null && payload.chainCursor !== "") return true;

  const pending = payload.pendingTxids;
  if (Array.isArray(pending) && pending.length > 0) return true;

  const pendingTxs = payload.pendingTxs;
  if (Array.isArray(pendingTxs) && pendingTxs.length > 0) return true;

  const processedIndex = payload.processedIndex;
  if (typeof processedIndex === "number" && processedIndex > 0) return true;

  if (payload.pagesExhausted === false) {
    const pagesFetched = payload.pagesFetched;
    if (typeof pagesFetched === "number" && pagesFetched > 0) return true;
    if (payload.chainCursor != null) return true;
  }

  if (payload.traceEdgesPending === true) return true;
  const traceEdgeIndex = payload.traceEdgeIndex;
  if (typeof traceEdgeIndex === "number" && traceEdgeIndex > 0) return true;

  return false;
}

/** Typed as better-sqlite3; D1 store casts at runtime (all terminators are awaited). */
export type Db = BetterSQLite3Database<typeof schema>;

const now = () => new Date().toISOString();

function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function lastInsertId(result: { lastInsertRowid?: number | bigint; meta?: { last_row_id?: number } }): number {
  if (result.lastInsertRowid != null) return Number(result.lastInsertRowid);
  if (result.meta?.last_row_id != null) return Number(result.meta.last_row_id);
  return 0;
}

function changesCount(result: { changes?: number; meta?: { changes?: number } }): number {
  if (result.changes != null) return result.changes;
  if (result.meta?.changes != null) return result.meta.changes;
  return 0;
}

export type AddressUpsertData = {
  address: string;
  role?: string;
  label?: string | null;
  source?: string;
  isFlaggedHacker?: boolean;
  hopFromHacker?: number | null;
  expandStatus?: string;
  expandProfile?: string | null;
  relayMetaJson?: string | null;
  fanoutMetaJson?: string | null;
  totalReceivedSats?: number;
  liveBalanceSats?: number | null;
  liveBalanceAt?: string | null;
};

export type EdgeUpsertData = {
  fromAddress: string;
  toAddress: string;
  txid: string;
  amountSats: number;
  blockTime?: string | null;
  hopFromHacker?: number | null;
  direction: string;
  edgeKind?: string | null;
  fanoutMetaJson?: string | null;
};

export type ChainApiProviderId = "esplora" | "mempool";

export interface ChainApiStatus {
  id: ChainApiProviderId;
  label: string;
  thresholdExceeded: boolean;
  thresholdSecondsLeft: number;
  lastThresholdAt: string | null;
  thresholdCount: number;
  strikeCount: number;
}

export interface StoreOptions {
  maxQueueDepth?: number;
  d1BatchSize?: number;
  d1?: D1Binding;
  subrequestBudget?: { canConsume(n: number): boolean; consume(n: number): void };
}

export type EnqueueJobOptions = {
  bypassQueueCap?: boolean;
};

function retryAfterSecondsLeft(retryAfterAt: string | null | undefined): number {
  if (!retryAfterAt) return 0;
  const remaining = (new Date(retryAfterAt).getTime() - Date.now()) / 1000;
  return Math.max(0, Math.ceil(remaining));
}

function providerRetryAfterAt(
  state: { esploraRetryAfterAt?: string | null; mempoolRetryAfterAt?: string | null } | undefined,
  provider: ChainApiProviderId,
): string | null {
  if (!state) return null;
  return provider === "esplora" ? (state.esploraRetryAfterAt ?? null) : (state.mempoolRetryAfterAt ?? null);
}

function providerStrikeCount(
  state:
    | {
        esploraStrikeCount?: number | null;
        mempoolStrikeCount?: number | null;
      }
    | undefined,
  provider: ChainApiProviderId,
): number {
  if (!state) return 0;
  return provider === "esplora" ? (state.esploraStrikeCount ?? 0) : (state.mempoolStrikeCount ?? 0);
}

function ingestContinuationExempt(type: string, payloadJson: string): boolean {
  if (type !== "backfill_hacker_address" && type !== "expand_downstream") return false;
  return isIngestContinuation(payloadJson);
}

export class Store {
  private maxQueueDepth: number;
  private d1BatchSize: number;
  private d1?: D1Binding;
  private subrequestBudget?: StoreOptions["subrequestBudget"];

  constructor(
    public db: Db,
    options?: StoreOptions,
  ) {
    this.maxQueueDepth = options?.maxQueueDepth ?? 360;
    this.d1BatchSize = options?.d1BatchSize ?? 8;
    this.d1 = options?.d1;
    this.subrequestBudget = options?.subrequestBudget;
  }

  consumeSubrequests(count = 1): void {
    this.trackSubrequest(count);
  }

  private trackSubrequest(count = 1): void {
    this.subrequestBudget?.consume(count);
  }

  canUseSubrequests(count = 1): boolean {
    if (!this.subrequestBudget) return true;
    return this.subrequestBudget.canConsume(count);
  }

  setSubrequestBudget(budget?: StoreOptions["subrequestBudget"]): void {
    this.subrequestBudget = budget;
  }

  private async shouldAllowEnqueue(
    type: string,
    payload: Record<string, unknown>,
    opts?: EnqueueJobOptions,
  ): Promise<boolean> {
    if (opts?.bypassQueueCap) return true;
    const payloadJson = JSON.stringify(payload);
    if (ingestContinuationExempt(type, payloadJson)) return true;

    const state = await this.getSchedulerState();
    if ((state?.queueSchedulingPaused ?? 0) !== 0) return false;

    const depth = await this.getQueueDepth();
    if (depth >= this.maxQueueDepth) {
      await this.setQueueSchedulingPaused(true);
      return false;
    }
    return true;
  }

  async setQueueSchedulingPaused(paused: boolean): Promise<void> {
    await this.db
      .update(schedulerState)
      .set({ queueSchedulingPaused: paused ? 1 : 0 })
      .where(eq(schedulerState.id, 1))
      .run();
  }

  async isQueueSchedulingPaused(): Promise<boolean> {
    const state = await this.getSchedulerState();
    return (state?.queueSchedulingPaused ?? 0) !== 0;
  }

  async maybeClearQueueSchedulingPause(): Promise<void> {
    const depth = await this.getQueueDepth();
    if (depth === 0) {
      await this.setQueueSchedulingPaused(false);
    }
  }

  getMaxQueueDepth(): number {
    return this.maxQueueDepth;
  }

  async upsertAddress(data: AddressUpsertData) {
    const ts = now();
    const role = data.role ?? "unknown";
    const label = data.label !== undefined ? data.label : null;
    const source = data.source ?? "derived";
    const isFlaggedHacker = data.isFlaggedHacker ?? false;
    const hopFromHacker = data.hopFromHacker !== undefined ? data.hopFromHacker : null;
    const expandStatus = data.expandStatus ?? "pending";
    const totalReceivedSats = data.totalReceivedSats ?? 0;
    const liveBalanceSats = data.liveBalanceSats !== undefined ? data.liveBalanceSats : null;
    const liveBalanceAt = data.liveBalanceAt !== undefined ? data.liveBalanceAt : null;

    const roleProvided = data.role !== undefined ? 1 : 0;
    const labelProvided = data.label !== undefined ? 1 : 0;
    const sourceProvided = data.source !== undefined ? 1 : 0;
    const isFlaggedHackerProvided = data.isFlaggedHacker !== undefined ? 1 : 0;
    const hopProvided = data.hopFromHacker !== undefined ? 1 : 0;
    const expandStatusProvided = data.expandStatus !== undefined ? 1 : 0;
    const totalReceivedProvided = data.totalReceivedSats !== undefined ? 1 : 0;
    const liveBalanceSatsProvided = data.liveBalanceSats !== undefined ? 1 : 0;
    const liveBalanceAtProvided = data.liveBalanceAt !== undefined ? 1 : 0;

    await this.db.run(sql`
      INSERT INTO addresses (
        address, role, label, source, is_flagged_hacker, created_at, first_seen_at, last_seen_at,
        hop_from_hacker, expand_status, total_received_sats, live_balance_sats, live_balance_at
      ) VALUES (
        ${data.address}, ${role}, ${label}, ${source}, ${isFlaggedHacker ? 1 : 0},
        ${ts}, ${ts}, ${ts}, ${hopFromHacker}, ${expandStatus}, ${totalReceivedSats},
        ${liveBalanceSats}, ${liveBalanceAt}
      )
      ON CONFLICT(address) DO UPDATE SET
        role = CASE
          WHEN addresses.role = 'hacker' AND excluded.role = 'victim' THEN addresses.role
          WHEN ${roleProvided} = 1 THEN excluded.role
          ELSE addresses.role END,
        label = CASE WHEN ${labelProvided} = 1 THEN excluded.label ELSE addresses.label END,
        source = CASE WHEN ${sourceProvided} = 1 THEN excluded.source ELSE addresses.source END,
        is_flagged_hacker = CASE
          WHEN ${isFlaggedHackerProvided} = 1 THEN excluded.is_flagged_hacker
          ELSE addresses.is_flagged_hacker END,
        hop_from_hacker = CASE
          WHEN ${hopProvided} = 1 THEN excluded.hop_from_hacker
          ELSE addresses.hop_from_hacker END,
        expand_status = CASE
          WHEN ${expandStatusProvided} = 1 THEN excluded.expand_status
          ELSE addresses.expand_status END,
        total_received_sats = CASE
          WHEN ${totalReceivedProvided} = 1 THEN excluded.total_received_sats
          ELSE addresses.total_received_sats END,
        live_balance_sats = CASE
          WHEN ${liveBalanceSatsProvided} = 1 THEN excluded.live_balance_sats
          ELSE addresses.live_balance_sats END,
        live_balance_at = CASE
          WHEN ${liveBalanceAtProvided} = 1 THEN excluded.live_balance_at
          ELSE addresses.live_balance_at END,
        last_seen_at = ${ts}
    `);
  }

  /** Insert address row only when absent; returns true when a new row was created. */
  async insertAddressIfMissing(data: AddressUpsertData): Promise<boolean> {
    const ts = now();
    const result = await this.db.run(sql`
      INSERT INTO addresses (
        address, role, label, source, is_flagged_hacker, created_at, first_seen_at, last_seen_at,
        hop_from_hacker, expand_status, total_received_sats, live_balance_sats, live_balance_at
      ) VALUES (
        ${data.address},
        ${data.role ?? "unknown"},
        ${data.label !== undefined ? data.label : null},
        ${data.source ?? "derived"},
        ${data.isFlaggedHacker ?? false ? 1 : 0},
        ${ts}, ${ts}, ${ts},
        ${data.hopFromHacker !== undefined ? data.hopFromHacker : null},
        ${data.expandStatus ?? "pending"},
        ${data.totalReceivedSats ?? 0},
        ${data.liveBalanceSats !== undefined ? data.liveBalanceSats : null},
        ${data.liveBalanceAt !== undefined ? data.liveBalanceAt : null}
      )
      ON CONFLICT(address) DO NOTHING
    `);
    return changesCount(result as { changes?: number; meta?: { changes?: number } }) > 0;
  }

  async getAddress(address: string) {
    return await this.db.select().from(addresses).where(eq(addresses.address, address)).get();
  }

  async listAllAddresses() {
    return await this.db
      .select({
        address: addresses.address,
        role: addresses.role,
        isFlaggedHacker: addresses.isFlaggedHacker,
      })
      .from(addresses)
      .all();
  }

  async listHackers(q?: string, activeOnly?: boolean) {
    const conditions = [eq(addresses.isFlaggedHacker, true)];
    if (activeOnly) conditions.push(gt(addresses.totalReceivedSats, 0));
    const base = and(...conditions);
    if (q?.trim()) {
      const pattern = `%${escapeLikePattern(q.trim())}%`;
      return await this.db
        .select()
        .from(addresses)
        .where(
          and(
            base,
            or(
              sql`${addresses.address} LIKE ${pattern} ESCAPE '\\'`,
              sql`${addresses.label} LIKE ${pattern} ESCAPE '\\'`,
            ),
          ),
        )
        .orderBy(desc(addresses.totalReceivedSats))
        .all();
    }
    return await this.db
      .select()
      .from(addresses)
      .where(base)
      .orderBy(desc(addresses.totalReceivedSats))
      .all();
  }

  private async executeSqlBatch(statements: ReturnType<typeof sql>[]): Promise<void> {
    if (statements.length === 0) return;
    const d1 = this.d1;
    const d1Batch = d1?.batch;
    if (d1 && d1Batch) {
      const dialect = new SQLiteAsyncDialect();
      const prepared = statements.map((statement) => {
        const query = dialect.sqlToQuery(statement);
        const stmt = d1.prepare(query.sql) as {
          bind(...values: unknown[]): { run(): Promise<unknown> };
        };
        return stmt.bind(...query.params);
      });
      await d1Batch.call(d1, prepared);
      return;
    }
    for (const statement of statements) {
      await this.db.run(statement);
    }
  }

  async upsertAddressesBatch(rows: AddressUpsertData[]): Promise<void> {
    if (rows.length === 0) return;
    const ts = now();
    for (let i = 0; i < rows.length; i += this.d1BatchSize) {
      const chunk = rows.slice(i, i + this.d1BatchSize);
      const statements = chunk.map((data) => {
        const role = data.role ?? "unknown";
        const label = data.label !== undefined ? data.label : null;
        const source = data.source ?? "derived";
        const isFlaggedHacker = data.isFlaggedHacker ?? false;
        const hopFromHacker = data.hopFromHacker !== undefined ? data.hopFromHacker : null;
        const expandStatus = data.expandStatus ?? "pending";
        const totalReceivedSats = data.totalReceivedSats ?? 0;
        const liveBalanceSats = data.liveBalanceSats !== undefined ? data.liveBalanceSats : null;
        const liveBalanceAt = data.liveBalanceAt !== undefined ? data.liveBalanceAt : null;
        const roleProvided = data.role !== undefined ? 1 : 0;
        const labelProvided = data.label !== undefined ? 1 : 0;
        const sourceProvided = data.source !== undefined ? 1 : 0;
        const isFlaggedHackerProvided = data.isFlaggedHacker !== undefined ? 1 : 0;
        const hopProvided = data.hopFromHacker !== undefined ? 1 : 0;
        const expandStatusProvided = data.expandStatus !== undefined ? 1 : 0;
        const totalReceivedProvided = data.totalReceivedSats !== undefined ? 1 : 0;
        const liveBalanceSatsProvided = data.liveBalanceSats !== undefined ? 1 : 0;
        const liveBalanceAtProvided = data.liveBalanceAt !== undefined ? 1 : 0;
        return sql`
          INSERT INTO addresses (
            address, role, label, source, is_flagged_hacker, created_at, first_seen_at, last_seen_at,
            hop_from_hacker, expand_status, total_received_sats, live_balance_sats, live_balance_at
          ) VALUES (
            ${data.address}, ${role}, ${label}, ${source}, ${isFlaggedHacker ? 1 : 0},
            ${ts}, ${ts}, ${ts}, ${hopFromHacker}, ${expandStatus}, ${totalReceivedSats},
            ${liveBalanceSats}, ${liveBalanceAt}
          )
          ON CONFLICT(address) DO UPDATE SET
            role = CASE
              WHEN addresses.role = 'hacker' AND excluded.role = 'victim' THEN addresses.role
              WHEN ${roleProvided} = 1 THEN excluded.role
              ELSE addresses.role END,
            label = CASE WHEN ${labelProvided} = 1 THEN excluded.label ELSE addresses.label END,
            source = CASE WHEN ${sourceProvided} = 1 THEN excluded.source ELSE addresses.source END,
            is_flagged_hacker = CASE
              WHEN ${isFlaggedHackerProvided} = 1 THEN excluded.is_flagged_hacker
              ELSE addresses.is_flagged_hacker END,
            hop_from_hacker = CASE
              WHEN ${hopProvided} = 1 THEN excluded.hop_from_hacker
              ELSE addresses.hop_from_hacker END,
            expand_status = CASE
              WHEN ${expandStatusProvided} = 1 THEN excluded.expand_status
              ELSE addresses.expand_status END,
            total_received_sats = CASE
              WHEN ${totalReceivedProvided} = 1 THEN excluded.total_received_sats
              ELSE addresses.total_received_sats END,
            live_balance_sats = CASE
              WHEN ${liveBalanceSatsProvided} = 1 THEN excluded.live_balance_sats
              ELSE addresses.live_balance_sats END,
            live_balance_at = CASE
              WHEN ${liveBalanceAtProvided} = 1 THEN excluded.live_balance_at
              ELSE addresses.live_balance_at END,
            last_seen_at = ${ts}
        `;
      });
      await this.executeSqlBatch(statements);
    }
  }

  async upsertEdgesBatch(rows: EdgeUpsertData[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const hackersToRecalc = new Set<string>();
    for (let i = 0; i < rows.length; i += this.d1BatchSize) {
      const chunk = rows.slice(i, i + this.d1BatchSize);
      const statements = chunk.map((data) =>
        sql`
          INSERT INTO edges (
            from_address, to_address, txid, amount_sats, block_time, hop_from_hacker, direction,
            edge_kind, fanout_meta_json
          ) VALUES (
            ${data.fromAddress}, ${data.toAddress}, ${data.txid}, ${data.amountSats},
            ${data.blockTime ?? null}, ${data.hopFromHacker ?? null}, ${data.direction},
            ${data.edgeKind ?? null}, ${data.fanoutMetaJson ?? null}
          )
          ON CONFLICT(from_address, to_address, txid) DO UPDATE SET
            amount_sats = excluded.amount_sats,
            block_time = COALESCE(excluded.block_time, edges.block_time),
            hop_from_hacker = COALESCE(excluded.hop_from_hacker, edges.hop_from_hacker),
            direction = excluded.direction,
            edge_kind = COALESCE(excluded.edge_kind, edges.edge_kind),
            fanout_meta_json = COALESCE(excluded.fanout_meta_json, edges.fanout_meta_json)
        `,
      );
      await this.executeSqlBatch(statements);
      for (const row of chunk) {
        if (row.direction === "in_to_hacker") hackersToRecalc.add(row.toAddress);
      }
    }
    return [...hackersToRecalc];
  }

  async recalcTotalReceivedFor(hackerAddresses: string[]): Promise<void> {
    const unique = [...new Set(hackerAddresses)];
    if (unique.length === 0) return;
    for (const hackerAddress of unique) {
      await this.recalcTotalReceived(hackerAddress);
    }
  }

  async upsertEdge(data: EdgeUpsertData) {
    const hackers = await this.upsertEdgesBatch([data]);
    if (hackers.length > 0) {
      await this.recalcTotalReceivedFor(hackers);
    }
  }

  async recalcTotalReceived(hackerAddress: string) {
    const row = await this.db
      .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
      .from(edges)
      .where(and(eq(edges.toAddress, hackerAddress), eq(edges.direction, "in_to_hacker")))
      .get();
    await this.db
      .update(addresses)
      .set({ totalReceivedSats: row?.total ?? 0 })
      .where(eq(addresses.address, hackerAddress))
      .run();
  }

  async recalcAllTotalReceived() {
    for (const hacker of await this.listHackers()) {
      await this.recalcTotalReceived(hacker.address);
    }
  }

  async deleteHackTraceEdges() {
    await this.db
      .delete(edges)
      .where(or(eq(edges.direction, "in_to_hacker"), eq(edges.direction, "out_from_hacker")))
      .run();
  }

  async listIndexedTxids() {
    return (await this.db.select({ txid: transactions.txid }).from(transactions).all()).map((r) => r.txid);
  }

  async resetHackerTotalReceived() {
    await this.db.update(addresses).set({ totalReceivedSats: 0 }).where(eq(addresses.isFlaggedHacker, true)).run();
  }

  async upsertTransaction(data: { txid: string; blockHeight?: number | null; blockTime?: string | null; feeSats?: number | null }) {
    const existing = await this.db.select().from(transactions).where(eq(transactions.txid, data.txid)).get();
    if (existing) {
      await this.db
        .update(transactions)
        .set({
          blockHeight: data.blockHeight ?? existing.blockHeight,
          blockTime: data.blockTime ?? existing.blockTime,
          feeSats: data.feeSats ?? existing.feeSats,
        })
        .where(eq(transactions.txid, data.txid))
        .run();
    } else {
      await this.db.insert(transactions).values(data).run();
    }
  }

  async getEdgesForHacker(hacker: string) {
    return await this.db
      .select()
      .from(edges)
      .where(or(eq(edges.fromAddress, hacker), eq(edges.toAddress, hacker)))
      .all();
  }

  async getEdgesToAddress(address: string) {
    return await this.db.select().from(edges).where(eq(edges.toAddress, address)).all();
  }

  async getEdgesFromAddress(address: string) {
    return await this.db.select().from(edges).where(eq(edges.fromAddress, address)).all();
  }

  async getTransaction(txid: string) {
    return await this.db.select().from(transactions).where(eq(transactions.txid, txid)).get();
  }

  async getTransactionsByTxids(txids: string[]): Promise<Map<string, Transaction>> {
    const unique = [...new Set(txids)];
    const txById = new Map<string, Transaction>();
    if (unique.length === 0) return txById;

    for (let i = 0; i < unique.length; i += TXID_BATCH_SIZE) {
      const chunk = unique.slice(i, i + TXID_BATCH_SIZE);
      const rows = await this.db
        .select()
        .from(transactions)
        .where(inArray(transactions.txid, chunk))
        .all();
      for (const row of rows) {
        txById.set(row.txid, row);
      }
    }
    return txById;
  }

  async getVictimStats(hacker: string, minEdgeSats?: number) {
    const conditions = [eq(edges.toAddress, hacker), eq(edges.direction, "in_to_hacker")];
    if (minEdgeSats != null) {
      conditions.push(gte(edges.amountSats, minEdgeSats));
    }
    const row = await this.db
      .select({
        count: sql<number>`count(distinct ${edges.fromAddress})`,
        total: sql<number>`coalesce(sum(${edges.amountSats}), 0)`,
      })
      .from(edges)
      .where(and(...conditions))
      .get();
    return { childCount: row?.count ?? 0, totalSats: row?.total ?? 0 };
  }

  async listVictimsForHacker(hacker: string, limit = 100) {
    return await this.db
      .select({
        address: edges.fromAddress,
        amountSats: edges.amountSats,
        txid: edges.txid,
        blockTime: edges.blockTime,
      })
      .from(edges)
      .where(and(eq(edges.toAddress, hacker), eq(edges.direction, "in_to_hacker")))
      .orderBy(desc(edges.amountSats))
      .limit(limit)
      .all();
  }

  /** All inbound edges from a specific victim to a hacker (no amount floor or limit). */
  async listEdgesFromVictimToHacker(victim: string, hacker: string) {
    return await this.db
      .select({
        address: edges.fromAddress,
        amountSats: edges.amountSats,
        txid: edges.txid,
        blockTime: edges.blockTime,
      })
      .from(edges)
      .where(
        and(
          eq(edges.fromAddress, victim),
          eq(edges.toAddress, hacker),
          eq(edges.direction, "in_to_hacker"),
        ),
      )
      .orderBy(desc(edges.amountSats))
      .all();
  }

  async getBlockTimeByHeight(blockHeight: number) {
    const row = await this.db
      .select({ blockTime: transactions.blockTime })
      .from(transactions)
      .where(and(eq(transactions.blockHeight, blockHeight), isNotNull(transactions.blockTime)))
      .limit(1)
      .get();
    return row?.blockTime ?? null;
  }

  async getAddressDetailAggregates(address: string) {
    const outgoing = await this.db
      .select({
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${edges.amountSats}), 0)`,
      })
      .from(edges)
      .where(eq(edges.fromAddress, address))
      .get();
    const touching = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(edges)
      .where(or(eq(edges.fromAddress, address), eq(edges.toAddress, address)))
      .get();
    return {
      outgoingEdgeCount: outgoing?.count ?? 0,
      totalSent: outgoing?.total ?? 0,
      relatedTxsTotal: touching?.count ?? 0,
    };
  }

  async getRecentEdgesForAddress(address: string, limit = ADDRESS_DETAIL_TX_LIMIT) {
    return await this.db
      .select({
        fromAddress: edges.fromAddress,
        toAddress: edges.toAddress,
        txid: edges.txid,
        amountSats: edges.amountSats,
        blockTime: edges.blockTime,
        txBlockTime: transactions.blockTime,
        txBlockHeight: transactions.blockHeight,
      })
      .from(edges)
      .leftJoin(transactions, eq(edges.txid, transactions.txid))
      .where(or(eq(edges.fromAddress, address), eq(edges.toAddress, address)))
      .orderBy(sql`coalesce(${transactions.blockTime}, ${edges.blockTime}) desc`)
      .limit(limit)
      .all();
  }

  async resolveHackTimingForAddress(address: string) {
    const row = await this.db
      .select({
        txid: edges.txid,
        edgeBlockTime: edges.blockTime,
        txBlockTime: transactions.blockTime,
        txBlockHeight: transactions.blockHeight,
      })
      .from(edges)
      .leftJoin(transactions, eq(edges.txid, transactions.txid))
      .where(
        and(
          or(eq(edges.fromAddress, address), eq(edges.toAddress, address)),
          or(
            isNotNull(transactions.blockHeight),
            isNotNull(transactions.blockTime),
            isNotNull(edges.blockTime),
          ),
        ),
      )
      .orderBy(
        sql`coalesce(${transactions.blockHeight}, 2147483647) asc`,
        sql`coalesce(${transactions.blockTime}, ${edges.blockTime}, '9999') asc`,
      )
      .limit(1)
      .get();

    if (!row) {
      return { hackOccurredAt: null as string | null, hackBlockHeight: null as number | null };
    }

    const hackBlockHeight = row.txBlockHeight ?? null;
    let hackOccurredAt = row.txBlockTime ?? row.edgeBlockTime ?? null;
    if (!hackOccurredAt && hackBlockHeight != null) {
      hackOccurredAt = await this.getBlockTimeByHeight(hackBlockHeight);
    }

    return { hackOccurredAt, hackBlockHeight };
  }

  async getAddressDetail(address: string) {
    const addr = await this.getAddress(address);
    if (!addr) return null;

    const { outgoingEdgeCount, totalSent, relatedTxsTotal } =
      await this.getAddressDetailAggregates(address);
    const recentEdges = await this.getRecentEdgesForAddress(address, ADDRESS_DETAIL_TX_LIMIT);

    const missingTxids = recentEdges
      .filter((e) => e.txBlockTime == null && e.blockTime == null)
      .map((e) => e.txid);
    const txById = await this.getTransactionsByTxids(missingTxids);

    const relatedTxs = recentEdges.map((e) => {
      const tx = txById.get(e.txid);
      return {
        txid: e.txid,
        blockTime: e.txBlockTime ?? e.blockTime ?? tx?.blockTime ?? null,
        amountSats: e.amountSats,
        direction: e.fromAddress === address ? "out" : "in",
        counterparty: e.fromAddress === address ? e.toAddress : e.fromAddress,
      };
    });

    const { hackOccurredAt, hackBlockHeight } = await this.resolveHackTimingForAddress(address);
    return {
      address: addr,
      totalSent,
      relatedTxs,
      outgoingEdgeCount,
      relatedTxsTotal,
      hackOccurredAt,
      hackBlockHeight,
    };
  }

  async listHackersForVictim(victim: string, minEdgeSats?: number) {
    const conditions = [
      eq(edges.fromAddress, victim),
      eq(edges.direction, "in_to_hacker"),
    ];
    if (minEdgeSats != null) {
      conditions.push(gte(edges.amountSats, minEdgeSats));
    }
    const rows = await this.db
      .select({
        hackerAddress: edges.toAddress,
        amountSats: edges.amountSats,
        txid: edges.txid,
        blockTime: edges.blockTime,
      })
      .from(edges)
      .innerJoin(addresses, eq(edges.toAddress, addresses.address))
      .where(and(...conditions, eq(addresses.isFlaggedHacker, true)))
      .orderBy(desc(edges.amountSats))
      .all();

    const byHacker = new Map<
      string,
      {
        address: string;
        label: string | null;
        totalSats: number;
        edges: Array<{ txid: string; amountSats: number; blockTime: string | null }>;
      }
    >();

    for (const row of rows) {
      let entry = byHacker.get(row.hackerAddress);
      if (!entry) {
        const hacker = await this.getAddress(row.hackerAddress);
        entry = {
          address: row.hackerAddress,
          label: hacker?.label ?? null,
          totalSats: 0,
          edges: [],
        };
        byHacker.set(row.hackerAddress, entry);
      }
      entry.totalSats += row.amountSats;
      entry.edges.push({
        txid: row.txid,
        amountSats: row.amountSats,
        blockTime: row.blockTime,
      });
    }

    return [...byHacker.values()].sort((a, b) => b.totalSats - a.totalSats);
  }

  async enqueueJob(
    type: string,
    payload: Record<string, unknown>,
    priority: number,
    runAfter?: string,
    opts?: EnqueueJobOptions,
  ): Promise<number | null> {
    if (!(await this.shouldAllowEnqueue(type, payload, opts))) return null;
    const result = await this.db
      .insert(jobs)
      .values({
        type,
        payloadJson: JSON.stringify(payload),
        status: "pending",
        priority,
        runAfter: runAfter ?? now(),
        createdAt: now(),
      })
      .run();
    return lastInsertId(result as { lastInsertRowid?: number | bigint; meta?: { last_row_id?: number } });
  }

  /**
   * Enqueue only when no matching active job exists (atomic INSERT ... WHERE NOT EXISTS).
   * Returns job id when inserted, null when skipped.
   */
  async enqueueJobIfAbsent(
    type: string,
    payload: Record<string, unknown>,
    priority: number,
    runAfter?: string,
    opts?: { dedupeTypes?: string[]; address?: string; bypassQueueCap?: boolean },
  ): Promise<number | null> {
    if (!(await this.shouldAllowEnqueue(type, payload, opts))) return null;
    const dedupeTypes = opts?.dedupeTypes ?? [type];
    const address =
      opts?.address ?? (typeof payload.address === "string" ? payload.address : undefined);
    const payloadJson = JSON.stringify(payload);
    const runAt = runAfter ?? now();
    const createdAt = now();
    const typeList = sql.join(dedupeTypes.map((t) => sql`${t}`), sql`, `);

    const result = await this.db.run(sql`
      INSERT INTO jobs (type, payload_json, status, priority, run_after, created_at)
      SELECT ${type}, ${payloadJson}, 'pending', ${priority}, ${runAt}, ${createdAt}
      WHERE NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE type IN (${typeList})
          AND status IN ('pending', 'running')
          AND (
            ${address ?? null} IS NULL
            OR json_extract(payload_json, '$.address') = ${address ?? null}
          )
      )
    `);

    if (changesCount(result as { changes?: number; meta?: { changes?: number } }) === 0) {
      return null;
    }
    return lastInsertId(result as { lastInsertRowid?: number | bigint; meta?: { last_row_id?: number } });
  }

  async countActiveJobs(type: string) {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          or(eq(jobs.status, "pending"), eq(jobs.status, "running")),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  async hasPendingJob(type: string, address?: string) {
    if (!address) {
      return !!(await this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, type), or(eq(jobs.status, "pending"), eq(jobs.status, "running"))))
        .get());
    }
    // Address must be pre-validated by API; bind as parameter (no raw SQL concat of user input).
    const pending = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          or(eq(jobs.status, "pending"), eq(jobs.status, "running")),
          jobPayloadAddressEq(address),
        ),
      )
      .get();
    return !!pending;
  }

  /**
   * Sliding fixed window counter. Returns whether the request is allowed under `limit`
   * within `windowSec`, and seconds until the window resets when denied.
   */
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const ts = Date.now();
    const windowMs = Math.max(1, windowSec) * 1000;
    const windowStart = new Date(ts).toISOString();

    const reset = await this.db.run(sql`
      UPDATE rate_limits
      SET window_start = ${windowStart}, count = 1
      WHERE key = ${key}
        AND (unixepoch(${windowStart}) - unixepoch(window_start)) * 1000 >= ${windowMs}
    `);
    if (changesCount(reset as { changes?: number; meta?: { changes?: number } }) > 0) {
      return { allowed: true, retryAfterSec: 0 };
    }

    const inserted = await this.db.run(sql`
      INSERT OR IGNORE INTO rate_limits (key, window_start, count)
      VALUES (${key}, ${windowStart}, 1)
    `);
    if (changesCount(inserted as { changes?: number; meta?: { changes?: number } }) > 0) {
      return { allowed: true, retryAfterSec: 0 };
    }

    const incremented = await this.db.run(sql`
      UPDATE rate_limits
      SET count = count + 1
      WHERE key = ${key}
        AND count < ${limit}
        AND (unixepoch(${windowStart}) - unixepoch(window_start)) * 1000 < ${windowMs}
    `);
    if (changesCount(incremented as { changes?: number; meta?: { changes?: number } }) > 0) {
      return { allowed: true, retryAfterSec: 0 };
    }

    const row = await this.db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
    const windowStartMs = row ? new Date(row.windowStart).getTime() : ts;
    const retryAfterSec = Math.max(1, Math.ceil((windowStartMs + windowMs - ts) / 1000));
    return { allowed: false, retryAfterSec };
  }

  async claimNextJob() {
    const ts = now();
    const job = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, ts)))
      .orderBy(desc(jobs.priority), asc(jobs.runAfter))
      .limit(1)
      .get();
    if (!job) return null;
    // Claim only if still pending (avoids double-claim under overlapping cron ticks).
    const claimed = await this.db
      .update(jobs)
      .set({ status: "running", startedAt: ts, completedAt: null })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
      .run();
    if (changesCount(claimed as { changes?: number; meta?: { changes?: number } }) === 0) {
      return null;
    }
    return { ...job, status: "running" as const, startedAt: ts, completedAt: null };
  }

  async claimNextIngestJob(opts?: { preferContinuation?: boolean }): Promise<Job | null> {
    const ts = now();
    const candidates = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.runAfter, ts),
          inArray(jobs.type, [...INGEST_JOB_TYPES]),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.runAfter))
      .limit(32)
      .all();

    if (candidates.length === 0) return null;

    let pick = candidates[0]!;
    if (opts?.preferContinuation) {
      const cont = candidates.find(
        (j) => isIngestContinuation(j.payloadJson) && (j.reclaimCount ?? 0) === 0,
      );
      if (cont) pick = cont;
    }

    const claimed = await this.db
      .update(jobs)
      .set({ status: "running", startedAt: ts, completedAt: null })
      .where(and(eq(jobs.id, pick.id), eq(jobs.status, "pending")))
      .run();
    if (changesCount(claimed as { changes?: number; meta?: { changes?: number } }) === 0) {
      return null;
    }
    return { ...pick, status: "running" as const, startedAt: ts, completedAt: null };
  }

  async completeJob(id: number) {
    await this.db
      .update(jobs)
      .set({
        status: "done",
        lastError: null,
        completedAt: now(),
        reclaimCount: 0,
        reclaimProgressJson: null,
      })
      .where(eq(jobs.id, id))
      .run();
  }

  async failJob(id: number, error: string, runAfter?: string) {
    const job = await this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    await this.db
      .update(jobs)
      .set({
        status: "pending",
        attempts: (job?.attempts ?? 0) + 1,
        lastError: error,
        runAfter: runAfter ?? now(),
        startedAt: null,
      })
      .where(eq(jobs.id, id))
      .run();
  }

  /** Push a stuck job to the back of the queue without incrementing attempts. */
  async deferJob(id: number, error: string, runAfter: string) {
    await this.db
      .update(jobs)
      .set({
        status: "pending",
        attempts: 0,
        lastError: error,
        runAfter,
        startedAt: null,
      })
      .where(eq(jobs.id, id))
      .run();
  }

  async clearJobReclaimState(id: number) {
    await this.db
      .update(jobs)
      .set({ reclaimCount: 0, reclaimProgressJson: null })
      .where(eq(jobs.id, id))
      .run();
  }

  /**
   * Reclaim running jobs to pending. When staleMs > 0, only jobs with null started_at
   * or started_at older than staleMs are reset (avoids interrupting an in-flight tick).
   * When staleMs is 0/omitted, all running jobs are reclaimed.
   */
  async resetRunningJobs(
    staleMs = 0,
    opts?: { jobReclaimDeferAfter?: number; jobDeferSec?: number },
  ): Promise<{ reclaimed: number; deferred: number }> {
    const cutoff = new Date(Date.now() - Math.max(0, staleMs)).toISOString();
    const staleCondition =
      staleMs <= 0
        ? eq(jobs.status, "running")
        : and(eq(jobs.status, "running"), or(isNull(jobs.startedAt), lte(jobs.startedAt, cutoff)));

    const staleJobs = await this.db.select().from(jobs).where(staleCondition).all();
    if (staleJobs.length === 0) return { reclaimed: 0, deferred: 0 };

    const deferAfter = opts?.jobReclaimDeferAfter ?? 0;
    const deferSec = opts?.jobDeferSec ?? 86400;
    let reclaimed = 0;
    let deferred = 0;

    for (const job of staleJobs) {
      const progress = extractIngestProgressSnapshot(job.payloadJson);
      const progressJson = JSON.stringify(progress);
      const nextReclaimCount = (job.reclaimCount ?? 0) + 1;
      const unchanged = job.reclaimProgressJson === progressJson;

      if (deferAfter > 0 && nextReclaimCount >= deferAfter && unchanged) {
        const runAfter = new Date(Date.now() + deferSec * 1000).toISOString();
        await this.deferJob(job.id, "deferred: reclaimed without progress", runAfter);
        await this.db
          .update(jobs)
          .set({
            reclaimCount: 0,
            reclaimProgressJson: null,
          })
          .where(eq(jobs.id, job.id))
          .run();
        deferred++;
        continue;
      }

      await this.db
        .update(jobs)
        .set({
          status: "pending",
          startedAt: null,
          reclaimCount: nextReclaimCount,
          reclaimProgressJson: progressJson,
          lastError: "reclaimed: stale running",
        })
        .where(eq(jobs.id, job.id))
        .run();
      reclaimed++;
    }

    return { reclaimed, deferred };
  }

  /** Acquire exclusive tick lease if none held or lease expired. */
  async tryAcquireTickLease(leaseMs: number): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + Math.max(1, leaseMs)).toISOString();
    const result = await this.db.run(sql`
      UPDATE scheduler_state
      SET tick_lease_until = ${untilIso}
      WHERE id = 1
        AND (tick_lease_until IS NULL OR tick_lease_until < ${nowIso})
    `);
    return changesCount(result as { changes?: number; meta?: { changes?: number } }) > 0;
  }

  async clearTickLease(): Promise<void> {
    await this.db.run(sql`
      UPDATE scheduler_state
      SET tick_lease_until = NULL
      WHERE id = 1
    `);
  }

  async getJob(id: number) {
    return await this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  async countPendingJobsBefore(priority: number, runAfter: string) {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          or(gt(jobs.priority, priority), and(eq(jobs.priority, priority), lte(jobs.runAfter, runAfter))),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  async getQueueDepth() {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.status, "pending"))
      .get();
    return row?.count ?? 0;
  }

  async getActiveJobSummary(filters?: { statuses?: string[]; type?: string }) {
    const statuses = filters?.statuses ?? ["pending", "running"];
    const conditions = [inArray(jobs.status, statuses)];
    if (filters?.type) conditions.push(eq(jobs.type, filters.type));
    return await this.db
      .select({
        status: jobs.status,
        type: jobs.type,
        count: sql<number>`count(*)`,
      })
      .from(jobs)
      .where(and(...conditions))
      .groupBy(jobs.status, jobs.type)
      .all();
  }

  async countActiveJobsMatching(filters?: { statuses?: string[]; type?: string }) {
    const statuses = filters?.statuses ?? ["pending", "running"];
    const conditions = [inArray(jobs.status, statuses)];
    if (filters?.type) conditions.push(eq(jobs.type, filters.type));
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(and(...conditions))
      .get();
    return row?.count ?? 0;
  }

  async listActiveJobs(opts?: { statuses?: string[]; type?: string; limit?: number; offset?: number }) {
    const statuses = opts?.statuses ?? ["pending", "running"];
    const conditions = [inArray(jobs.status, statuses)];
    if (opts?.type) conditions.push(eq(jobs.type, opts.type));
    const base = this.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.priority), asc(jobs.runAfter));
    if (opts?.limit != null && opts?.offset != null) {
      return await base.limit(opts.limit).offset(opts.offset).all();
    }
    if (opts?.limit != null) {
      return await base.limit(opts.limit).all();
    }
    if (opts?.offset != null) {
      return await base.offset(opts.offset).all();
    }
    return await base.all();
  }

  async getSchedulerState() {
    return await this.db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
  }

  async updateSchedulerState(data: {
    nextProviderCallAt?: string;
    lastProviderUsed?: string;
    lastProviderSuccessAt?: string;
    lastApiThresholdAt?: string;
    apiThresholdCount?: number;
    lastEsploraThresholdAt?: string;
    lastMempoolThresholdAt?: string;
    esploraThresholdCount?: number;
    mempoolThresholdCount?: number;
    esploraStrikeCount?: number;
    mempoolStrikeCount?: number;
    esploraRetryAfterAt?: string | null;
    mempoolRetryAfterAt?: string | null;
    queueSchedulingPaused?: number;
    backfillHealAuditIndex?: number;
    hackerPollIndex?: number;
    maintenanceCronCounter?: number;
    rateLimitMs?: number;
    btcUsdPrice?: number;
    btcUsdPriceAt?: string;
    btcUsdRefreshAttemptAt?: string;
  }) {
    await this.db
      .update(schedulerState)
      .set(data)
      .where(eq(schedulerState.id, 1))
      .run();
  }

  async setBtcUsdPrice(usd: number, at: string) {
    await this.updateSchedulerState({ btcUsdPrice: usd, btcUsdPriceAt: at });
  }

  async setBtcUsdRefreshAttemptAt(at: string) {
    await this.updateSchedulerState({ btcUsdRefreshAttemptAt: at });
  }

  async getBtcUsdPrice(): Promise<{ usd: number; at: string } | null> {
    const state = await this.getSchedulerState();
    if (state?.btcUsdPrice == null || !state.btcUsdPriceAt) return null;
    return { usd: state.btcUsdPrice, at: state.btcUsdPriceAt };
  }

  async recordApiThreshold(
    provider: ChainApiProviderId,
    opts: { retryAfterAt: string; strikeCount: number },
  ): Promise<void> {
    const state = await this.getSchedulerState();
    const ts = now();
    const esploraCount = state?.esploraThresholdCount ?? 0;
    const mempoolCount = state?.mempoolThresholdCount ?? 0;
    const updates: Parameters<Store["updateSchedulerState"]>[0] = {
      lastApiThresholdAt: ts,
      apiThresholdCount: (state?.apiThresholdCount ?? 0) + 1,
    };
    if (provider === "esplora") {
      updates.lastEsploraThresholdAt = ts;
      updates.esploraThresholdCount = esploraCount + 1;
      updates.esploraStrikeCount = opts.strikeCount;
      updates.esploraRetryAfterAt = opts.retryAfterAt;
    } else {
      updates.lastMempoolThresholdAt = ts;
      updates.mempoolThresholdCount = mempoolCount + 1;
      updates.mempoolStrikeCount = opts.strikeCount;
      updates.mempoolRetryAfterAt = opts.retryAfterAt;
    }
    await this.updateSchedulerState(updates);
  }

  async clearProviderStrike(provider: ChainApiProviderId): Promise<void> {
    if (provider === "esplora") {
      await this.updateSchedulerState({
        esploraStrikeCount: 0,
        esploraRetryAfterAt: null,
      });
    } else {
      await this.updateSchedulerState({
        mempoolStrikeCount: 0,
        mempoolRetryAfterAt: null,
      });
    }
  }

  providerRetrySecondsLeft(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
    provider: ChainApiProviderId,
  ): number {
    return retryAfterSecondsLeft(providerRetryAfterAt(state, provider));
  }

  isProviderInBackoff(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
    provider: ChainApiProviderId,
  ): boolean {
    return this.providerRetrySecondsLeft(state, provider) > 0;
  }

  async earliestProviderRetryAt(): Promise<string | null> {
    const state = await this.getSchedulerState();
    const candidates = [
      providerRetryAfterAt(state, "esplora"),
      providerRetryAfterAt(state, "mempool"),
    ].filter(Boolean) as string[];
    const future = candidates.filter((iso) => new Date(iso).getTime() > Date.now());
    if (future.length === 0) return null;
    return future.reduce((a, b) => (a < b ? a : b));
  }

  getProviderStrikeCount(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
    provider: ChainApiProviderId,
  ): number {
    return providerStrikeCount(state, provider);
  }

  async getSyncState(address: string) {
    return await this.db.select().from(syncState).where(eq(syncState.address, address)).get();
  }

  async upsertSyncState(address: string, data: { lastSeenTxid?: string; lastBlockHeight?: number | null }) {
    const existing = await this.getSyncState(address);
    const ts = now();
    if (existing) {
      await this.db
        .update(syncState)
        .set({
          lastSeenTxid: data.lastSeenTxid ?? existing.lastSeenTxid,
          lastBlockHeight: data.lastBlockHeight ?? existing.lastBlockHeight,
          lastPolledAt: ts,
        })
        .where(eq(syncState.address, address))
        .run();
    } else {
      await this.db
        .insert(syncState)
        .values({
          address,
          lastSeenTxid: data.lastSeenTxid ?? null,
          lastBlockHeight: data.lastBlockHeight ?? null,
          lastPolledAt: ts,
        })
        .run();
    }
  }

  async touchSyncPoll(address: string) {
    const existing = await this.getSyncState(address);
    const ts = now();
    if (existing) {
      await this.db.update(syncState).set({ lastPolledAt: ts }).where(eq(syncState.address, address)).run();
    } else {
      await this.db.insert(syncState).values({ address, lastPolledAt: ts }).run();
    }
  }

  async countIndexedTxsForHacker(address: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(distinct ${edges.txid})` })
      .from(edges)
      .where(or(eq(edges.toAddress, address), eq(edges.fromAddress, address)))
      .get();
    return row?.count ?? 0;
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
      backfillComplete: row.backfillComplete === 1,
      lastBackfillAuditAt: row.lastBackfillAuditAt ?? null,
      chainTxCountAtAudit: row.chainTxCountAtAudit ?? null,
    };
  }

  async upsertBackfillState(
    address: string,
    payload: Record<string, unknown> | null,
    complete?: boolean,
  ) {
    const existing = await this.getSyncState(address);
    const patch: {
      backfillStateJson?: string | null;
      backfillComplete?: number;
    } = {};
    if (complete === true) {
      patch.backfillStateJson = null;
      patch.backfillComplete = 1;
    } else {
      if (payload) patch.backfillStateJson = JSON.stringify(payload);
      if (complete === false) patch.backfillComplete = 0;
    }
    if (existing) {
      await this.db.update(syncState).set(patch).where(eq(syncState.address, address)).run();
    } else {
      await this.db
        .insert(syncState)
        .values({
          address,
          backfillStateJson: patch.backfillStateJson ?? null,
          backfillComplete: patch.backfillComplete ?? 0,
        })
        .run();
    }
  }

  async updateBackfillAudit(address: string, chainTxCount: number) {
    const existing = await this.getSyncState(address);
    const ts = now();
    if (existing) {
      await this.db
        .update(syncState)
        .set({
          lastBackfillAuditAt: ts,
          chainTxCountAtAudit: chainTxCount,
        })
        .where(eq(syncState.address, address))
        .run();
    } else {
      await this.db
        .insert(syncState)
        .values({
          address,
          lastBackfillAuditAt: ts,
          chainTxCountAtAudit: chainTxCount,
          backfillComplete: 0,
        })
        .run();
    }
  }

  async getBackfillHealAuditIndex(): Promise<number> {
    return (await this.getSchedulerState())?.backfillHealAuditIndex ?? 0;
  }

  async setBackfillHealAuditIndex(index: number) {
    await this.updateSchedulerState({ backfillHealAuditIndex: index });
  }

  async getHackerPollIndex(): Promise<number> {
    return (await this.getSchedulerState())?.hackerPollIndex ?? 0;
  }

  async setHackerPollIndex(index: number) {
    await this.updateSchedulerState({ hackerPollIndex: index });
  }

  async incrementMaintenanceCronCounter(): Promise<number> {
    await this.db.run(sql`
      UPDATE scheduler_state
      SET maintenance_cron_counter = maintenance_cron_counter + 1
      WHERE id = 1
    `);
    return (await this.getSchedulerState())?.maintenanceCronCounter ?? 0;
  }

  /** Atomically advance round-robin hacker poll index; returns index to use this tick. */
  async claimNextHackerPollIndex(hackerCount: number): Promise<number> {
    if (hackerCount <= 0) return 0;
    const rows = await this.db.all<{ idx: number }>(sql`
      UPDATE scheduler_state
      SET hacker_poll_index = (hacker_poll_index + 1) % ${hackerCount}
      WHERE id = 1
      RETURNING ((hacker_poll_index - 1 + ${hackerCount}) % ${hackerCount}) AS idx
    `);
    const idx = rows[0]?.idx;
    if (idx != null) return Number(idx);
    return (await this.getHackerPollIndex()) % hackerCount;
  }

  async getSourceSync(source: string) {
    return await this.db.select().from(sourceSyncState).where(eq(sourceSyncState.source, source)).get();
  }

  async upsertSourceSync(source: string, data: { lastAddressCount?: number; lastContentHash?: string }) {
    const ts = now();
    const lastAddressCount = data.lastAddressCount ?? null;
    const lastContentHash = data.lastContentHash ?? null;
    await this.db.run(sql`
      INSERT INTO source_sync_state (source, last_sync_at, last_address_count, last_content_hash)
      VALUES (${source}, ${ts}, ${lastAddressCount}, ${lastContentHash})
      ON CONFLICT(source) DO UPDATE SET
        last_sync_at = excluded.last_sync_at,
        last_address_count = COALESCE(excluded.last_address_count, source_sync_state.last_address_count),
        last_content_hash = COALESCE(excluded.last_content_hash, source_sync_state.last_content_hash)
    `);
  }

  async getCrawlStats() {
    const pending = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(and(eq(addresses.expandStatus, "pending"), or(eq(addresses.role, "downstream"), eq(addresses.role, "hacker"))))
      .get();
    const expanded = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(eq(addresses.expandStatus, "expanded"))
      .get();
    const maxHop = await this.db
      .select({ max: sql<number>`max(${addresses.hopFromHacker})` })
      .from(addresses)
      .where(eq(addresses.role, "downstream"))
      .get();
    return {
      crawlPendingCount: pending?.count ?? 0,
      crawlExpandedCount: expanded?.count ?? 0,
      crawlMaxHopReached: maxHop?.max ?? 0,
    };
  }

  async getDownstreamFrontier(limit: number, maxDepth: number) {
    return await this.db
      .select({ address: addresses.address })
      .from(addresses)
      .where(
        and(
          or(eq(addresses.role, "downstream"), eq(addresses.role, "hacker")),
          eq(addresses.expandStatus, "pending"),
          sql`${addresses.hopFromHacker} < ${maxDepth}`,
        ),
      )
      .orderBy(asc(addresses.hopFromHacker), asc(addresses.lastSeenAt))
      .limit(limit)
      .all();
  }

  async listDownstreamForPoll(limit: number, maxDepth: number, minIntervalSec: number) {
    const cutoff = new Date(Date.now() - minIntervalSec * 1000).toISOString();
    return await this.db
      .select({ address: addresses.address })
      .from(addresses)
      .leftJoin(syncState, eq(addresses.address, syncState.address))
      .where(
        and(
          eq(addresses.role, "downstream"),
          or(eq(addresses.expandStatus, "expanded"), eq(addresses.expandStatus, "pending")),
          sql`${addresses.hopFromHacker} < ${maxDepth}`,
          or(sql`${syncState.lastPolledAt} IS NULL`, sql`${syncState.lastPolledAt} <= ${cutoff}`),
        ),
      )
      .orderBy(asc(syncState.lastPolledAt), asc(addresses.hopFromHacker))
      .limit(limit)
      .all();
  }

  async countDownstreamTreeNodes(maxDepth: number) {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(and(eq(addresses.role, "downstream"), sql`${addresses.hopFromHacker} < ${maxDepth}`))
      .get();
    return row?.count ?? 0;
  }

  async countDownstreamPollDue(maxDepth: number, minIntervalSec: number) {
    const cutoff = new Date(Date.now() - minIntervalSec * 1000).toISOString();
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .leftJoin(syncState, eq(addresses.address, syncState.address))
      .where(
        and(
          eq(addresses.role, "downstream"),
          or(eq(addresses.expandStatus, "expanded"), eq(addresses.expandStatus, "pending")),
          sql`${addresses.hopFromHacker} < ${maxDepth}`,
          or(sql`${syncState.lastPolledAt} IS NULL`, sql`${syncState.lastPolledAt} <= ${cutoff}`),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  async getDownstreamMonitorStats(maxDepth: number, minIntervalSec: number) {
    return {
      treeNodeCount: await this.countDownstreamTreeNodes(maxDepth),
      downstreamPollDueCount: await this.countDownstreamPollDue(maxDepth, minIntervalSec),
    };
  }

  async setExpandStatus(address: string, status: string) {
    await this.db
      .update(addresses)
      .set({ expandStatus: status, lastExpandedAt: now() })
      .where(eq(addresses.address, address))
      .run();
  }

  async setExpandProfile(
    address: string,
    profile: string,
    meta?: { relayMetaJson?: string | null; fanoutMetaJson?: string | null },
  ) {
    await this.db
      .update(addresses)
      .set({
        expandProfile: profile,
        ...(meta?.relayMetaJson !== undefined ? { relayMetaJson: meta.relayMetaJson } : {}),
        ...(meta?.fanoutMetaJson !== undefined ? { fanoutMetaJson: meta.fanoutMetaJson } : {}),
      })
      .where(eq(addresses.address, address))
      .run();
  }

  async getMonitoringStatus(staleSec: number, thresholdCooldownSec: number) {
    const scheduler = await this.getSchedulerState();
    const lastChainApiAt = scheduler?.lastProviderSuccessAt ?? null;
    const lastApiThresholdAt = scheduler?.lastApiThresholdAt ?? null;
    const apiThresholdCount = scheduler?.apiThresholdCount ?? 0;

    const esploraSecondsLeft = this.providerRetrySecondsLeft(scheduler, "esplora");
    const mempoolSecondsLeft = this.providerRetrySecondsLeft(scheduler, "mempool");
    const apiThresholdSecondsLeft = Math.max(esploraSecondsLeft, mempoolSecondsLeft);

    const chainApis: ChainApiStatus[] = [
      {
        id: "esplora",
        label: "Blockstream Esplora",
        thresholdExceeded: esploraSecondsLeft > 0,
        thresholdSecondsLeft: esploraSecondsLeft,
        lastThresholdAt: scheduler?.lastEsploraThresholdAt ?? null,
        thresholdCount: scheduler?.esploraThresholdCount ?? 0,
        strikeCount: providerStrikeCount(scheduler, "esplora"),
      },
      {
        id: "mempool",
        label: "Mempool Space",
        thresholdExceeded: mempoolSecondsLeft > 0,
        thresholdSecondsLeft: mempoolSecondsLeft,
        lastThresholdAt: scheduler?.lastMempoolThresholdAt ?? null,
        thresholdCount: scheduler?.mempoolThresholdCount ?? 0,
        strikeCount: providerStrikeCount(scheduler, "mempool"),
      },
    ];

    const apiThresholdExceeded = apiThresholdSecondsLeft > 0;

    const sources = await this.db.select().from(sourceSyncState).all();
    const externalSources = sources.map((s) => ({
      source: s.source,
      lastSyncAt: s.lastSyncAt ?? null,
      lastAddressCount: s.lastAddressCount ?? null,
    }));

    let lastExternalSyncAt: string | null = null;
    for (const s of sources) {
      if (!s.lastSyncAt) continue;
      if (!lastExternalSyncAt || s.lastSyncAt > lastExternalSyncAt) {
        lastExternalSyncAt = s.lastSyncAt;
      }
    }

    const lastDoneJob = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "done"))
      .orderBy(sql`coalesce(${jobs.completedAt}, ${jobs.createdAt}) desc`, desc(jobs.id))
      .limit(1)
      .get();

    const lastCompletedJobAt = lastDoneJob?.completedAt ?? lastDoneJob?.createdAt ?? null;
    const lastCompletedJobType = lastDoneJob?.type ?? null;
    let lastCompletedJobDurationMs: number | null = null;
    if (lastDoneJob?.startedAt && lastDoneJob?.completedAt) {
      const startMs = new Date(lastDoneJob.startedAt).getTime();
      const endMs = new Date(lastDoneJob.completedAt).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        lastCompletedJobDurationMs = endMs - startMs;
      }
    }

    const lastJobAt = lastCompletedJobAt;

    const candidates = [lastChainApiAt, lastExternalSyncAt, lastJobAt].filter(Boolean) as string[];
    const lastActivityAt =
      candidates.length > 0 ? candidates.reduce((a, b) => (a > b ? a : b)) : null;

    const monitoringActive =
      lastActivityAt != null &&
      Date.now() - new Date(lastActivityAt).getTime() <= staleSec * 1000;

    return {
      lastChainApiAt,
      lastExternalSyncAt,
      lastJobAt,
      lastCompletedJobType,
      lastCompletedJobDurationMs,
      lastCompletedJobAt,
      lastActivityAt,
      monitoringActive,
      apiThresholdExceeded,
      lastApiThresholdAt,
      apiThresholdCount,
      apiThresholdCooldownSec: thresholdCooldownSec,
      apiThresholdSecondsLeft,
      chainApis,
      queueSchedulingPaused: (scheduler?.queueSchedulingPaused ?? 0) !== 0,
      maxQueueDepth: this.maxQueueDepth,
      externalSources,
    };
  }

  async getStats() {
    const victims = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(eq(addresses.role, "victim"))
      .get();
    const hackers = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(and(eq(addresses.isFlaggedHacker, true), gt(addresses.totalReceivedSats, 0)))
      .get();
    const totalIn = await this.db
      .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
      .from(edges)
      .where(eq(edges.direction, "in_to_hacker"))
      .get();
    const totalOut = await this.db
      .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
      .from(edges)
      .where(eq(edges.direction, "out_from_hacker"))
      .get();
    const lastJob = await this.db
      .select()
      .from(jobs)
      .where(ne(jobs.status, "pending"))
      .orderBy(desc(jobs.id))
      .limit(1)
      .get();
    const scheduler = await this.getSchedulerState();
    return {
      victimCount: victims?.count ?? 0,
      hackerCount: hackers?.count ?? 0,
      totalInSats: totalIn?.total ?? 0,
      totalOutSats: totalOut?.total ?? 0,
      lastJobAt: lastJob?.createdAt ?? null,
      btcUsdPrice: scheduler?.btcUsdPrice ?? null,
      btcUsdPriceAt: scheduler?.btcUsdPriceAt ?? null,
    };
  }

  /** Distinct victims with in_to_hacker edges into this hacker. */
  async listVictimAddressesForHacker(hacker: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ address: edges.fromAddress })
      .from(edges)
      .where(and(eq(edges.toAddress, hacker), eq(edges.direction, "in_to_hacker")))
      .all();
    return rows.map((r) => r.address);
  }

  /** Addresses reachable via out_from_hacker BFS starting at hacker (excludes hacker). */
  async collectDownstreamAddresses(hacker: string): Promise<string[]> {
    const seen = new Set<string>([hacker]);
    const queue = [hacker];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const outs = await this.db
        .select({ to: edges.toAddress })
        .from(edges)
        .where(and(eq(edges.fromAddress, cur), eq(edges.direction, "out_from_hacker")))
        .all();
      for (const row of outs) {
        if (!seen.has(row.to)) {
          seen.add(row.to);
          queue.push(row.to);
        }
      }
    }
    seen.delete(hacker);
    return [...seen];
  }

  async deleteEdgesTouchingAddress(address: string): Promise<number> {
    const result = await this.db
      .delete(edges)
      .where(or(eq(edges.fromAddress, address), eq(edges.toAddress, address)))
      .run();
    return changesCount(result as { changes?: number; meta?: { changes?: number } });
  }

  async countInToHackerEdgesToOtherFlagged(victim: string, excludeHacker: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(edges)
      .innerJoin(addresses, eq(edges.toAddress, addresses.address))
      .where(
        and(
          eq(edges.fromAddress, victim),
          eq(edges.direction, "in_to_hacker"),
          eq(addresses.isFlaggedHacker, true),
          ne(edges.toAddress, excludeHacker),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  async hasEdgeWithOtherFlaggedHacker(address: string, excludeHacker: string): Promise<boolean> {
    const touching = [
      ...(await this.getEdgesFromAddress(address)),
      ...(await this.getEdgesToAddress(address)),
    ];
    for (const e of touching) {
      const other = e.fromAddress === address ? e.toAddress : e.fromAddress;
      if (other === excludeHacker || other === address) continue;
      const row = await this.getAddress(other);
      if (row?.isFlaggedHacker) return true;
    }
    return false;
  }

  async hasOutFromHackerInboundOutside(
    address: string,
    candidateSet: Set<string>,
    excludeHacker: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ from: edges.fromAddress })
      .from(edges)
      .where(and(eq(edges.toAddress, address), eq(edges.direction, "out_from_hacker")))
      .all();
    return rows.some((r) => r.from !== excludeHacker && !candidateSet.has(r.from));
  }

  async deleteAddress(address: string): Promise<void> {
    await this.db.delete(syncState).where(eq(syncState.address, address)).run();
    await this.db.delete(addresses).where(eq(addresses.address, address)).run();
  }

  async deleteActiveJobsForAddress(address: string): Promise<number> {
    const result = await this.db
      .delete(jobs)
      .where(
        and(
          or(eq(jobs.status, "pending"), eq(jobs.status, "running")),
          jobPayloadAddressEq(address),
        ),
      )
      .run();
    return changesCount(result as { changes?: number; meta?: { changes?: number } });
  }

  async deleteActiveJobs(): Promise<{ deleted: number; pending: number; running: number }> {
    const pendingRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.status, "pending"))
      .get();
    const runningRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.status, "running"))
      .get();
    const pending = pendingRow?.count ?? 0;
    const running = runningRow?.count ?? 0;
    await this.db
      .delete(jobs)
      .where(or(eq(jobs.status, "pending"), eq(jobs.status, "running")))
      .run();
    return { deleted: pending + running, pending, running };
  }
}
