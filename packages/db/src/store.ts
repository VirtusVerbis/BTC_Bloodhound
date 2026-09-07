import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { D1Binding } from "./d1.js";
import type { D1QuotaKind } from "./d1Quota.js";
import type { D1RowMeter } from "./d1RowMeter.js";
import { todayUtcDate } from "./d1RowMeter.js";
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
  type Address,
  type Edge,
  type Job,
  type Transaction,
} from "./schema.js";
import {
  mergeRecentHackerActivity,
  parseRecentHackersJson,
  recentHackersEqual,
  serializeRecentHackers,
  type RecentHackerActivityDelta,
  type RecentHackerEntry,
} from "./recentHackers.js";

const INGEST_JOB_TYPES = [
  "backfill_hacker_address",
  "audit_hacker_backfill",
  "expand_downstream",
] as const;

const MAINT_COSMETIC_JOB_TYPES = [
  "poll_hacker_address",
  "poll_downstream_address",
  "sync_coldcardwatch",
  "sync_vercel_trackers",
  "process_tx",
  "refresh_live_balance",
  "refresh_btc_usd_price",
  "backfill_op_return",
] as const;

export interface ClaimAgeBoost {
  enabled: boolean;
  intervalSec: number;
  maxBoost: number;
  eligibleTypes: readonly string[];
}

function jobRunnableAtExpr() {
  return sql`CASE WHEN ${jobs.runAfter} > ${jobs.createdAt} THEN ${jobs.runAfter} ELSE ${jobs.createdAt} END`;
}

function jobWaitSecExpr(ts: string) {
  return sql`(strftime('%s', ${ts}) - strftime('%s', ${jobRunnableAtExpr()}))`;
}

function jobAgeBoostExpr(ageBoost: ClaimAgeBoost, ts: string) {
  if (!ageBoost.enabled || ageBoost.intervalSec <= 0 || ageBoost.eligibleTypes.length === 0) {
    return sql`0`;
  }
  const eligible = sql.join(ageBoost.eligibleTypes.map((t) => sql`${t}`), sql`, `);
  return sql`CASE WHEN ${jobs.type} IN (${eligible}) THEN
    MIN(${ageBoost.maxBoost}, CAST(${jobWaitSecExpr(ts)} / ${ageBoost.intervalSec} AS INTEGER))
    ELSE 0 END`;
}

function effectivePriorityExpr(ageBoost?: ClaimAgeBoost, ts?: string) {
  if (ageBoost?.enabled && ageBoost.intervalSec > 0) {
    return sql`${jobs.priority} + ${jobAgeBoostExpr(ageBoost, ts!)}`;
  }
  return sql`${jobs.priority}`;
}

function jobClaimOrderBy(ageBoost?: ClaimAgeBoost, ts?: string) {
  return [desc(effectivePriorityExpr(ageBoost, ts)), asc(jobs.runAfter), asc(jobs.createdAt)];
}

function targetAgeBoost(
  type: string,
  runAfter: string,
  createdAt: string,
  ageBoost: ClaimAgeBoost,
  ts: string,
): number {
  if (!ageBoost.enabled || ageBoost.intervalSec <= 0 || !ageBoost.eligibleTypes.includes(type)) {
    return 0;
  }
  const tsMs = new Date(ts).getTime();
  const runnableMs = Math.max(new Date(createdAt).getTime(), new Date(runAfter).getTime());
  const waitSec = Math.max(0, Math.floor((tsMs - runnableMs) / 1000));
  return Math.min(ageBoost.maxBoost, Math.floor(waitSec / ageBoost.intervalSec));
}

/** Cloudflare D1 allows max 100 bound params per query; reserve room for other binds. */
const D1_IN_CLAUSE_CHUNK_SIZE = 80;
const ADDRESS_DETAIL_TX_LIMIT = 50;
const OP_RETURN_SPEND_TX_LIMIT = 200;
const OP_RETURN_GRAPH_LABEL_MAX_CHARS = 48;
const OP_RETURN_DISPLAY_DELIMITER = " · ";

function opReturnTruncatedFlag(text: string): boolean {
  return text.length > OP_RETURN_GRAPH_LABEL_MAX_CHARS;
}

type OpReturnSegment = { text: string; txid: string; kind: "own" | "incoming" };

function combineOpReturnSegments(segments: OpReturnSegment[]): {
  opReturn: string;
  opReturnTruncated: boolean;
  opReturnTxid: string | null;
} {
  const opReturn = segments.map((s) => s.text).join(OP_RETURN_DISPLAY_DELIMITER);
  const ownSegment = segments.find((s) => s.kind === "own");
  const opReturnTxid = ownSegment?.txid ?? segments[0]?.txid ?? null;
  return {
    opReturn,
    opReturnTruncated: opReturnTruncatedFlag(opReturn),
    opReturnTxid,
  };
}

function dedupeOpReturnSegments(segments: OpReturnSegment[]): OpReturnSegment[] {
  const seen = new Set<string>();
  const out: OpReturnSegment[] = [];
  for (const segment of segments) {
    if (seen.has(segment.text)) continue;
    seen.add(segment.text);
    out.push(segment);
  }
  return out;
}

export interface OutEdgeKeysetCursor {
  amountSats: number;
  toAddress: string;
}

function outEdgeKeysetAfter(cursor: OutEdgeKeysetCursor) {
  const clause = or(
    lt(edges.amountSats, cursor.amountSats),
    and(eq(edges.amountSats, cursor.amountSats), gt(edges.toAddress, cursor.toAddress)),
  );
  if (!clause) throw new Error("invalid keyset cursor");
  return clause;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length > 0 ? [items] : [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

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
  queueSchedulingResumeDepth?: number;
  maxPendingExpandPerAddress?: number;
  maxPendingExpandGlobal?: number;
  d1BatchSize?: number;
  d1?: D1Binding;
  d1RowMeter?: D1RowMeter;
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

function expandPayloadAddress(payload: Record<string, unknown>): string | undefined {
  return typeof payload.address === "string" ? payload.address : undefined;
}

export class Store {
  private maxQueueDepth: number;
  private queueSchedulingResumeDepth: number;
  private maxPendingExpandPerAddress: number;
  private maxPendingExpandGlobal: number;
  private d1BatchSize: number;
  private d1?: D1Binding;
  private subrequestBudget?: StoreOptions["subrequestBudget"];
  private recentHackerActivityBuffer?: Map<string, RecentHackerActivityDelta>;

  constructor(
    public db: Db,
    options?: StoreOptions,
  ) {
    this.maxQueueDepth = options?.maxQueueDepth ?? 360;
    this.queueSchedulingResumeDepth =
      options?.queueSchedulingResumeDepth ?? Math.floor(this.maxQueueDepth / 2);
    this.maxPendingExpandPerAddress = options?.maxPendingExpandPerAddress ?? 2;
    this.maxPendingExpandGlobal = options?.maxPendingExpandGlobal ?? 40;
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
    const continuation = isIngestContinuation(payloadJson);

    if (type === "expand_downstream") {
      const address = expandPayloadAddress(payload);
      if (address) {
        const perAddr = await this.countActiveJobsForAddress("expand_downstream", address);
        if (perAddr >= this.maxPendingExpandPerAddress) return false;
      }
      const globalExpand = await this.countActiveJobs("expand_downstream");
      if (globalExpand >= this.maxPendingExpandGlobal) return false;
    }

    const state = await this.getSchedulerState();
    const schedulingPaused = (state?.queueSchedulingPaused ?? 0) !== 0;
    if (schedulingPaused) {
      if (type === "expand_downstream") return false;
      if (type === "backfill_hacker_address" && continuation) return true;
      return false;
    }

    const depth = await this.getQueueDepth();
    if (depth >= this.maxQueueDepth) {
      await this.setQueueSchedulingPaused(true);
      if (!continuation) return false;
      return true;
    }
    return true;
  }

  async setCronIndexerPaused(paused: boolean): Promise<void> {
    await this.db
      .update(schedulerState)
      .set({ cronIndexerPaused: paused ? 1 : 0 })
      .where(eq(schedulerState.id, 1))
      .run();
  }

  async isCronIndexerPaused(): Promise<boolean> {
    const state = await this.getSchedulerState();
    return (state?.cronIndexerPaused ?? 0) !== 0;
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
    if (depth <= this.queueSchedulingResumeDepth) {
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

  async upsertEdgesBatch(rows: EdgeUpsertData[]): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += this.d1BatchSize) {
      const chunk = rows.slice(i, i + this.d1BatchSize);
      const inToHackerRows = chunk.filter((row) => row.direction === "in_to_hacker");
      const oldAmountByKey = new Map<string, number>();
      if (inToHackerRows.length > 0) {
        const txids = [...new Set(inToHackerRows.map((row) => row.txid))];
        for (const txidChunk of chunkArray(txids, D1_IN_CLAUSE_CHUNK_SIZE)) {
          const existing = await this.db
            .select({
              fromAddress: edges.fromAddress,
              toAddress: edges.toAddress,
              txid: edges.txid,
              amountSats: edges.amountSats,
            })
            .from(edges)
            .where(
              and(
                inArray(edges.txid, txidChunk),
                eq(edges.direction, "in_to_hacker"),
              ),
            )
            .all();
          for (const row of existing) {
            oldAmountByKey.set(`${row.fromAddress}|${row.toAddress}|${row.txid}`, row.amountSats);
          }
        }
      }

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

      const deltaByHacker = new Map<string, number>();
      for (const row of inToHackerRows) {
        const key = `${row.fromAddress}|${row.toAddress}|${row.txid}`;
        const oldAmount = oldAmountByKey.get(key) ?? 0;
        const delta = row.amountSats - oldAmount;
        if (delta === 0) continue;
        deltaByHacker.set(row.toAddress, (deltaByHacker.get(row.toAddress) ?? 0) + delta);
      }
      for (const [hackerAddress, delta] of deltaByHacker) {
        await this.applyTotalReceivedDelta(hackerAddress, delta);
      }
    }
  }

  private async applyTotalReceivedDelta(hackerAddress: string, deltaSats: number): Promise<void> {
    if (deltaSats === 0) return;
    await this.db
      .update(addresses)
      .set({
        totalReceivedSats: sql`${addresses.totalReceivedSats} + ${deltaSats}`,
      })
      .where(eq(addresses.address, hackerAddress))
      .run();
  }

  async recalcTotalReceivedFor(hackerAddresses: string[]): Promise<void> {
    const unique = [...new Set(hackerAddresses)];
    if (unique.length === 0) return;
    for (const hackerAddress of unique) {
      await this.recalcTotalReceived(hackerAddress);
    }
  }

  async upsertEdge(data: EdgeUpsertData) {
    await this.upsertEdgesBatch([data]);
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

  async upsertTransaction(data: {
    txid: string;
    blockHeight?: number | null;
    blockTime?: string | null;
    feeSats?: number | null;
    opReturnDisplay?: string | null;
  }) {
    const existing = await this.db.select().from(transactions).where(eq(transactions.txid, data.txid)).get();
    let opReturnDisplay = existing?.opReturnDisplay ?? null;
    if (data.opReturnDisplay !== undefined) {
      const hasReadable = Boolean(existing?.opReturnDisplay && existing.opReturnDisplay !== "");
      if (!hasReadable) {
        opReturnDisplay = data.opReturnDisplay;
      }
    }
    if (existing) {
      await this.db
        .update(transactions)
        .set({
          blockHeight: data.blockHeight ?? existing.blockHeight,
          blockTime: data.blockTime ?? existing.blockTime,
          feeSats: data.feeSats ?? existing.feeSats,
          opReturnDisplay,
        })
        .where(eq(transactions.txid, data.txid))
        .run();
    } else {
      await this.db
        .insert(transactions)
        .values({
          txid: data.txid,
          blockHeight: data.blockHeight ?? null,
          blockTime: data.blockTime ?? null,
          feeSats: data.feeSats ?? null,
          opReturnDisplay: data.opReturnDisplay ?? null,
        })
        .run();
    }
  }

  async listTxidsMissingOpReturn(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ txid: transactions.txid })
      .from(transactions)
      .where(isNull(transactions.opReturnDisplay))
      .orderBy(asc(transactions.blockHeight), asc(transactions.txid))
      .limit(limit)
      .all();
    return rows.map((r) => r.txid);
  }

  async countTransactionsMissingOpReturn(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(isNull(transactions.opReturnDisplay))
      .get();
    return Number(row?.count ?? 0);
  }

  async getOpReturnDisplayByTxids(txids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(txids)];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;

    for (const chunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const rows = await this.db
        .select({
          txid: transactions.txid,
          opReturnDisplay: transactions.opReturnDisplay,
        })
        .from(transactions)
        .where(inArray(transactions.txid, chunk))
        .all();
      for (const row of rows) {
        if (row.opReturnDisplay && row.opReturnDisplay !== "") {
          out.set(row.txid, row.opReturnDisplay);
        }
      }
    }
    return out;
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

  async countOutEdgesFromAddress(
    address: string,
    opts: { minEdgeSats?: number } = {},
  ): Promise<number> {
    const conditions = [eq(edges.fromAddress, address), eq(edges.direction, "out_from_hacker")];
    const minEdgeSats = opts.minEdgeSats ?? 0;
    if (minEdgeSats > 0) conditions.push(gte(edges.amountSats, minEdgeSats));
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(edges)
      .where(and(...conditions))
      .get();
    return Number(row?.count ?? 0);
  }

  async getOutEdgesFromAddress(
    address: string,
    opts: { minEdgeSats?: number; limit: number; after?: OutEdgeKeysetCursor },
  ): Promise<Edge[]> {
    const conditions = [eq(edges.fromAddress, address), eq(edges.direction, "out_from_hacker")];
    const minEdgeSats = opts.minEdgeSats ?? 0;
    if (minEdgeSats > 0) conditions.push(gte(edges.amountSats, minEdgeSats));
    if (opts.after) conditions.push(outEdgeKeysetAfter(opts.after));
    return await this.db
      .select()
      .from(edges)
      .where(and(...conditions))
      .orderBy(desc(edges.amountSats), asc(edges.toAddress))
      .limit(opts.limit)
      .all();
  }

  async getOutEdgesFromParents(
    parents: string[],
    opts: {
      minEdgeSats?: number;
      limit: number;
      after?: { parentIndex: number; amountSats: number; toAddress: string };
    },
  ): Promise<{ edges: Edge[]; nextAfter: { parentIndex: number; amountSats: number; toAddress: string } | null }> {
    const unique = [...new Set(parents)].filter(Boolean);
    const result: Edge[] = [];
    let parentIndex = opts.after?.parentIndex ?? 0;
    let edgeAfter: OutEdgeKeysetCursor | undefined =
      opts.after != null
        ? { amountSats: opts.after.amountSats, toAddress: opts.after.toAddress }
        : undefined;

    while (parentIndex < unique.length && result.length < opts.limit) {
      const parent = unique[parentIndex]!;
      const remaining = opts.limit - result.length;
      const rows = await this.getOutEdgesFromAddress(parent, {
        minEdgeSats: opts.minEdgeSats,
        limit: remaining,
        after: edgeAfter,
      });
      result.push(...rows);
      if (rows.length < remaining) {
        parentIndex++;
        edgeAfter = undefined;
      } else {
        const last = rows[rows.length - 1]!;
        return {
          edges: result,
          nextAfter: {
            parentIndex,
            amountSats: last.amountSats,
            toAddress: last.toAddress,
          },
        };
      }
    }

    return { edges: result, nextAfter: null };
  }

  async getAddressesMap(addressList: string[]): Promise<Map<string, Address>> {
    const unique = [...new Set(addressList)].filter(Boolean);
    const result = new Map<string, Address>();
    if (unique.length === 0) return result;
    for (const chunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const rows = await this.db.select().from(addresses).where(inArray(addresses.address, chunk)).all();
      for (const row of rows) result.set(row.address, row);
    }
    return result;
  }

  async getEdgesFromAddressesMap(fromAddresses: string[]): Promise<Map<string, Edge[]>> {
    const unique = [...new Set(fromAddresses)].filter(Boolean);
    const result = new Map<string, Edge[]>();
    if (unique.length === 0) return result;
    for (const addr of unique) result.set(addr, []);
    for (const chunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const rows = await this.db.select().from(edges).where(inArray(edges.fromAddress, chunk)).all();
      for (const row of rows) {
        const bucket = result.get(row.fromAddress);
        if (bucket) bucket.push(row);
      }
    }
    return result;
  }

  async getTransaction(txid: string) {
    return await this.db.select().from(transactions).where(eq(transactions.txid, txid)).get();
  }

  async getTransactionsByTxids(txids: string[]): Promise<Map<string, Transaction>> {
    const unique = [...new Set(txids)];
    const txById = new Map<string, Transaction>();
    if (unique.length === 0) return txById;

    for (const chunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const chunkRows = chunk;
      const rows = await this.db
        .select()
        .from(transactions)
        .where(inArray(transactions.txid, chunkRows))
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

  /** Distinct victim addresses with in_to_hacker edges into this hacker (for graph filtering). */
  async getVictimAddressSetForHacker(hacker: string): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ address: edges.fromAddress })
      .from(edges)
      .where(and(eq(edges.toAddress, hacker), eq(edges.direction, "in_to_hacker")))
      .all();
    return new Set(rows.map((row) => row.address));
  }

  /** True when address has any in_to_hacker edge (sent funds into a hacker). */
  async isKnownVictimAddress(address: string): Promise<boolean> {
    const row = await this.db
      .select({ fromAddress: edges.fromAddress })
      .from(edges)
      .where(and(eq(edges.fromAddress, address), eq(edges.direction, "in_to_hacker")))
      .limit(1)
      .get();
    return row != null;
  }

  /** True when address has in_to_hacker into any of the given flagged hackers. */
  async isVictimOfHackers(victimAddress: string, hackers: Set<string>): Promise<boolean> {
    if (hackers.size === 0) return false;
    const hackerList = [...hackers];
    for (const chunk of chunkArray(hackerList, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const row = await this.db
        .select({ fromAddress: edges.fromAddress })
        .from(edges)
        .where(
          and(
            eq(edges.fromAddress, victimAddress),
            eq(edges.direction, "in_to_hacker"),
            inArray(edges.toAddress, chunk),
          ),
        )
        .limit(1)
        .get();
      if (row) return true;
    }
    return false;
  }

  /** Subset of addresses that are victims of any flagged hacker in the set. */
  async filterVictimsAmong(addresses: string[], hackers: Set<string>): Promise<Set<string>> {
    const unique = [...new Set(addresses)];
    if (unique.length === 0 || hackers.size === 0) return new Set();
    const hackerList = [...hackers];
    const victims = new Set<string>();
    for (const addrChunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      for (const hackerChunk of chunkArray(hackerList, D1_IN_CLAUSE_CHUNK_SIZE)) {
        const rows = await this.db
          .selectDistinct({ fromAddress: edges.fromAddress })
          .from(edges)
          .where(
            and(
              inArray(edges.fromAddress, addrChunk),
              eq(edges.direction, "in_to_hacker"),
              inArray(edges.toAddress, hackerChunk),
            ),
          )
          .all();
        for (const row of rows) victims.add(row.fromAddress);
      }
    }
    return victims;
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
      return {
        hackOccurredAt: null as string | null,
        hackBlockHeight: null as number | null,
        hackTxid: null as string | null,
      };
    }

    const hackBlockHeight = row.txBlockHeight ?? null;
    let hackOccurredAt = row.txBlockTime ?? row.edgeBlockTime ?? null;
    if (!hackOccurredAt && hackBlockHeight != null) {
      hackOccurredAt = await this.getBlockTimeByHeight(hackBlockHeight);
    }

    return { hackOccurredAt, hackBlockHeight, hackTxid: row.txid };
  }

  /** Spend-side txids for one or more addresses, latest first, deduped, capped. */
  async listSpendTxidsOrderedForAddresses(
    spenderAddresses: string[],
    limit = OP_RETURN_SPEND_TX_LIMIT,
  ): Promise<string[]> {
    const unique = [...new Set(spenderAddresses)];
    if (unique.length === 0) return [];

    const rows: Array<{
      txid: string;
      txBlockHeight: number | null;
      txBlockTime: string | null;
      edgeBlockTime: string | null;
    }> = [];

    for (const chunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const part = await this.db
        .select({
          txid: edges.txid,
          txBlockHeight: transactions.blockHeight,
          txBlockTime: transactions.blockTime,
          edgeBlockTime: edges.blockTime,
        })
        .from(edges)
        .leftJoin(transactions, eq(edges.txid, transactions.txid))
        .where(inArray(edges.fromAddress, chunk))
        .orderBy(
          desc(sql`coalesce(${transactions.blockHeight}, 0)`),
          desc(sql`coalesce(${transactions.blockTime}, ${edges.blockTime}, '')`),
        )
        .all();
      rows.push(...part);
    }

    rows.sort((a, b) => {
      const heightA = a.txBlockHeight ?? 0;
      const heightB = b.txBlockHeight ?? 0;
      if (heightB !== heightA) return heightB - heightA;
      const timeA = a.txBlockTime ?? a.edgeBlockTime ?? "";
      const timeB = b.txBlockTime ?? b.edgeBlockTime ?? "";
      return timeB.localeCompare(timeA);
    });

    const seen = new Set<string>();
    const txids: string[] = [];
    for (const row of rows) {
      if (seen.has(row.txid)) continue;
      seen.add(row.txid);
      txids.push(row.txid);
      if (txids.length >= limit) break;
    }
    return txids;
  }

  /** Incoming funding txids (out_from_hacker edges to this address), latest first, deduped. */
  async listIncomingOutFromHackerTxids(
    address: string,
    limit = OP_RETURN_SPEND_TX_LIMIT,
  ): Promise<string[]> {
    const rows = await this.db
      .select({
        txid: edges.txid,
        txBlockHeight: transactions.blockHeight,
        txBlockTime: transactions.blockTime,
        edgeBlockTime: edges.blockTime,
      })
      .from(edges)
      .leftJoin(transactions, eq(edges.txid, transactions.txid))
      .where(
        and(
          eq(edges.toAddress, address),
          eq(edges.direction, "out_from_hacker"),
          or(isNull(edges.edgeKind), ne(edges.edgeKind, "victim_dust")),
        ),
      )
      .orderBy(
        desc(sql`coalesce(${transactions.blockHeight}, 0)`),
        desc(sql`coalesce(${transactions.blockTime}, ${edges.blockTime}, '')`),
      )
      .all();

    const seen = new Set<string>();
    const txids: string[] = [];
    for (const row of rows) {
      if (seen.has(row.txid)) continue;
      seen.add(row.txid);
      txids.push(row.txid);
      if (txids.length >= limit) break;
    }
    return txids;
  }

  async resolveOpReturnFromSpenders(
    spenderAddresses: string[],
  ): Promise<{ opReturn: string | null; opReturnTxid: string | null }> {
    const txids = await this.listSpendTxidsOrderedForAddresses(spenderAddresses);
    if (txids.length === 0) {
      return { opReturn: null, opReturnTxid: null };
    }
    const displays = await this.getOpReturnDisplayByTxids(txids);
    for (const txid of txids) {
      const text = displays.get(txid);
      if (text) {
        return { opReturn: text, opReturnTxid: txid };
      }
    }
    return { opReturn: null, opReturnTxid: null };
  }

  async resolveOpReturnSegments(address: string): Promise<OpReturnSegment[]> {
    const segments: OpReturnSegment[] = [];

    const own = await this.resolveOpReturnFromSpenders([address]);
    if (own.opReturn && own.opReturnTxid) {
      segments.push({ text: own.opReturn, txid: own.opReturnTxid, kind: "own" });
    }

    const addr = await this.getAddress(address);
    if (addr?.role === "downstream" && !(await this.isKnownVictimAddress(address))) {
      const incomingTxids = await this.listIncomingOutFromHackerTxids(address);
      if (incomingTxids.length > 0) {
        const displays = await this.getOpReturnDisplayByTxids(incomingTxids);
        for (const txid of incomingTxids) {
          const text = displays.get(txid);
          if (text) {
            segments.push({ text, txid, kind: "incoming" });
            break;
          }
        }
      }
    }

    return dedupeOpReturnSegments(segments);
  }

  async resolveOpReturnForAddress(address: string): Promise<{
    opReturn: string | null;
    opReturnTruncated: boolean;
    opReturnTxid: string | null;
  }> {
    const segments = await this.resolveOpReturnSegments(address);
    if (segments.length > 0) {
      const combined = combineOpReturnSegments(segments);
      return {
        opReturn: combined.opReturn,
        opReturnTruncated: combined.opReturnTruncated,
        opReturnTxid: combined.opReturnTxid,
      };
    }

    const addr = await this.getAddress(address);
    if (!addr?.isFlaggedHacker) {
      return { opReturn: null, opReturnTruncated: false, opReturnTxid: null };
    }

    const downstreamRows = await this.db
      .selectDistinct({ toAddress: edges.toAddress })
      .from(edges)
      .where(and(eq(edges.fromAddress, address), eq(edges.direction, "out_from_hacker")))
      .all();

    for (const row of downstreamRows) {
      const downstreamSegments = await this.resolveOpReturnSegments(row.toAddress);
      if (downstreamSegments.length > 0) {
        const combined = combineOpReturnSegments(downstreamSegments);
        return {
          opReturn: combined.opReturn,
          opReturnTruncated: combined.opReturnTruncated,
          opReturnTxid: combined.opReturnTxid,
        };
      }
    }

    return { opReturn: null, opReturnTruncated: false, opReturnTxid: null };
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

    const { hackOccurredAt, hackBlockHeight, hackTxid } = await this.resolveHackTimingForAddress(address);
    const { opReturn, opReturnTruncated, opReturnTxid } = await this.resolveOpReturnForAddress(address);
    return {
      address: addr,
      totalSent,
      relatedTxs,
      outgoingEdgeCount,
      relatedTxsTotal,
      hackOccurredAt,
      hackBlockHeight,
      hackTxid,
      opReturn,
      opReturnTruncated,
      opReturnTxid,
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

  async countActiveJobsForAddress(type: string, address: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          or(eq(jobs.status, "pending"), eq(jobs.status, "running")),
          jobPayloadAddressEq(address),
        ),
      )
      .get();
    return Number(row?.count ?? 0);
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

  /** Raise priority (and optionally stamp ops opsPriority) on pending expand_downstream for one address. */
  async bumpPendingExpandDownstream(
    address: string,
    priority: number,
    opts?: { stampOps?: boolean },
  ): Promise<{ updated: number; jobIds: number[] }> {
    const stampOps = opts?.stampOps !== false;
    const rows = await this.db
      .select({ id: jobs.id, payloadJson: jobs.payloadJson })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "expand_downstream"),
          eq(jobs.status, "pending"),
          jobPayloadAddressEq(address),
        ),
      )
      .all();

    const jobIds: number[] = [];
    for (const row of rows) {
      let payloadJson = row.payloadJson;
      if (stampOps) {
        const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
        payload.ops = true;
        payload.opsPriority = priority;
        payloadJson = JSON.stringify(payload);
      }
      const result = await this.db
        .update(jobs)
        .set({ priority, payloadJson })
        .where(and(eq(jobs.id, row.id), eq(jobs.status, "pending")))
        .run();
      if (changesCount(result as { changes?: number; meta?: { changes?: number } }) > 0) {
        jobIds.push(row.id);
      }
    }
    return { updated: jobIds.length, jobIds };
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

  async claimNextJob(ageBoost?: ClaimAgeBoost) {
    const ts = now();
    const job = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, ts)))
      .orderBy(...jobClaimOrderBy(ageBoost, ts))
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

  /** Force-claim oldest maint/cosmetic job that has waited at least minWaitSec. */
  async claimOldestMaintCosmeticJob(
    minWaitSec: number,
    opts?: { excludeIds?: number[]; eligibleTypes?: readonly string[] },
  ): Promise<Job | null> {
    if (minWaitSec <= 0) return null;
    const ts = now();
    const types = opts?.eligibleTypes ?? MAINT_COSMETIC_JOB_TYPES;
    const conditions = [
      eq(jobs.status, "pending"),
      lte(jobs.runAfter, ts),
      inArray(jobs.type, [...types]),
      gte(jobWaitSecExpr(ts), minWaitSec),
    ];
    const excludeIds = opts?.excludeIds ?? [];
    if (excludeIds.length > 0) {
      conditions.push(notInArray(jobs.id, excludeIds));
    }
    const job = await this.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .get();
    if (!job) return null;
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

  /** Runnable pending ingest jobs in priority order (read-only peek for tick planning). */
  async listPendingIngestCandidates(limit = 32): Promise<Job[]> {
    const ts = now();
    return await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.runAfter, ts),
          inArray(jobs.type, [...INGEST_JOB_TYPES]),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(limit)
      .all();
  }

  /** Claim a specific ingest job by id (atomic pending → running). */
  async claimIngestJobById(id: number): Promise<Job | null> {
    const ts = now();
    const job = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.status, "pending"),
          lte(jobs.runAfter, ts),
          inArray(jobs.type, [...INGEST_JOB_TYPES]),
        ),
      )
      .get();
    if (!job) return null;
    const claimed = await this.db
      .update(jobs)
      .set({ status: "running", startedAt: ts, completedAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.status, "pending")))
      .run();
    if (changesCount(claimed as { changes?: number; meta?: { changes?: number } }) === 0) {
      return null;
    }
    return { ...job, status: "running" as const, startedAt: ts, completedAt: null };
  }

  async claimNextIngestJob(opts?: { preferContinuation?: boolean }): Promise<Job | null> {
    const candidates = await this.listPendingIngestCandidates(32);
    if (candidates.length === 0) return null;

    const ts = now();
    let pick = candidates[0]!;
    if (opts?.preferContinuation) {
      const cont = candidates.find(
        (j) => isIngestContinuation(j.payloadJson) && (j.reclaimCount ?? 0) === 0,
      );
      if (cont) pick = cont;
    }

    if (
      (pick.reclaimCount ?? 0) > 0 &&
      isIngestContinuation(pick.payloadJson)
    ) {
      const alt = candidates.find((j) => (j.reclaimCount ?? 0) === 0);
      if (alt) pick = alt;
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

  /** True when a runnable pending ingest job has saved continuation state. */
  async hasPendingIngestContinuation(): Promise<boolean> {
    const ts = now();
    const rows = await this.db
      .select({ payloadJson: jobs.payloadJson })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.runAfter, ts),
          inArray(jobs.type, [...INGEST_JOB_TYPES]),
        ),
      )
      .limit(32)
      .all();
    return rows.some((row) => isIngestContinuation(row.payloadJson));
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
    opts?: { jobReclaimDeferAfter?: number; jobReclaimDeferSec?: number },
  ): Promise<{ reclaimed: number; deferred: number }> {
    const cutoff = new Date(Date.now() - Math.max(0, staleMs)).toISOString();
    const staleCondition =
      staleMs <= 0
        ? eq(jobs.status, "running")
        : and(eq(jobs.status, "running"), or(isNull(jobs.startedAt), lte(jobs.startedAt, cutoff)));

    const staleJobs = await this.db.select().from(jobs).where(staleCondition).all();
    if (staleJobs.length === 0) return { reclaimed: 0, deferred: 0 };

    const deferAfter = opts?.jobReclaimDeferAfter ?? 0;
    const deferSec = opts?.jobReclaimDeferSec ?? 86400;
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

  async countPendingJobsBefore(priority: number, runAfter: string, createdAt?: string) {
    const ahead =
      createdAt != null
        ? or(
            gt(jobs.priority, priority),
            and(eq(jobs.priority, priority), lt(jobs.runAfter, runAfter)),
            and(eq(jobs.priority, priority), eq(jobs.runAfter, runAfter), lt(jobs.createdAt, createdAt)),
          )
        : or(gt(jobs.priority, priority), and(eq(jobs.priority, priority), lte(jobs.runAfter, runAfter)));
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), ahead))
      .get();
    return row?.count ?? 0;
  }

  async countPendingJobsBeforeEffective(
    priority: number,
    runAfter: string,
    createdAt: string,
    type: string,
    ageBoost?: ClaimAgeBoost,
  ) {
    const ts = now();
    const eff = effectivePriorityExpr(ageBoost, ts);
    const boost =
      ageBoost ??
      ({ enabled: false, intervalSec: 1, maxBoost: 0, eligibleTypes: [] } satisfies ClaimAgeBoost);
    const targetEff = priority + targetAgeBoost(type, runAfter, createdAt, boost, ts);
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.runAfter, ts),
          or(
            sql`${eff} > ${targetEff}`,
            and(sql`${eff} = ${targetEff}`, lt(jobs.runAfter, runAfter)),
            and(sql`${eff} = ${targetEff}`, eq(jobs.runAfter, runAfter), lt(jobs.createdAt, createdAt)),
          ),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  async getQueueDepth() {
    const ts = now();
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, ts)))
      .get();
    return row?.count ?? 0;
  }

  /** All pending jobs including future run_after (ops/debug). */
  async getPendingQueueDepthAll() {
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
      .orderBy(desc(jobs.priority), asc(jobs.runAfter), asc(jobs.createdAt));
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
    d1ReadRetryAfterAt?: string | null;
    d1WriteRetryAfterAt?: string | null;
    queueSchedulingPaused?: number;
    cronIndexerPaused?: number;
    backfillHealAuditIndex?: number;
    hackerPollIndex?: number;
    maintenanceCronCounter?: number;
    rateLimitMs?: number;
    btcUsdPrice?: number;
    btcUsdPriceAt?: string;
    btcUsdRefreshAttemptAt?: string;
    quotaDayUtc?: string | null;
    d1RowsReadTotal?: number;
    d1RowsWrittenTotal?: number;
    workersRequestsTotal?: number;
    d1RowsReadCron?: number;
    d1RowsWrittenCron?: number;
    workersRequestsCron?: number;
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

  async setD1QuotaPaused(kind: D1QuotaKind, retryAt: string): Promise<void> {
    if (kind === "read") {
      await this.updateSchedulerState({ d1ReadRetryAfterAt: retryAt });
    } else {
      await this.updateSchedulerState({ d1WriteRetryAfterAt: retryAt });
    }
  }

  async clearExpiredD1QuotaPause(): Promise<void> {
    const state = await this.getSchedulerState();
    if (!state) return;
    const ts = Date.now();
    const updates: Parameters<Store["updateSchedulerState"]>[0] = {};
    if (state.d1ReadRetryAfterAt && new Date(state.d1ReadRetryAfterAt).getTime() <= ts) {
      updates.d1ReadRetryAfterAt = null;
    }
    if (state.d1WriteRetryAfterAt && new Date(state.d1WriteRetryAfterAt).getTime() <= ts) {
      updates.d1WriteRetryAfterAt = null;
    }
    if (Object.keys(updates).length > 0) {
      await this.updateSchedulerState(updates);
    }
  }

  async isD1QuotaBlocked(kind?: D1QuotaKind): Promise<boolean> {
    const state = await this.getSchedulerState();
    const ts = Date.now();
    const readBlocked =
      state?.d1ReadRetryAfterAt != null && new Date(state.d1ReadRetryAfterAt).getTime() > ts;
    const writeBlocked =
      state?.d1WriteRetryAfterAt != null && new Date(state.d1WriteRetryAfterAt).getTime() > ts;
    if (kind === "read") return readBlocked;
    if (kind === "write") return writeBlocked;
    return readBlocked || writeBlocked;
  }

  async getD1QuotaStatus(limits?: {
    rowsReadLimit: number;
    rowsWrittenLimit: number;
    workersRequestsLimit: number;
  }): Promise<{
    readRetryAfterAt: string | null;
    writeRetryAfterAt: string | null;
    blocked: boolean;
    rowsRead: number;
    rowsWritten: number;
    workersRequests: number;
    rowsReadLimit: number;
    rowsWrittenLimit: number;
    workersRequestsLimit: number;
  }> {
    const snapshot = await this.getQuotaSnapshot();
    const state = await this.getSchedulerState();
    const readRetryAfterAt = state?.d1ReadRetryAfterAt ?? null;
    const writeRetryAfterAt = state?.d1WriteRetryAfterAt ?? null;
    const blocked = await this.isD1QuotaBlocked();
    return {
      readRetryAfterAt,
      writeRetryAfterAt,
      blocked,
      rowsRead: snapshot.rowsReadTotal,
      rowsWritten: snapshot.rowsWrittenTotal,
      workersRequests: snapshot.workersRequestsTotal,
      rowsReadLimit: limits?.rowsReadLimit ?? 5_000_000,
      rowsWrittenLimit: limits?.rowsWrittenLimit ?? 100_000,
      workersRequestsLimit: limits?.workersRequestsLimit ?? 100_000,
    };
  }

  async getQuotaSnapshot(): Promise<{
    quotaDayUtc: string;
    rowsReadTotal: number;
    rowsWrittenTotal: number;
    workersRequestsTotal: number;
    rowsReadCron: number;
    rowsWrittenCron: number;
    workersRequestsCron: number;
  }> {
    const today = todayUtcDate();
    const state = await this.getSchedulerState();
    if (!state) {
      return {
        quotaDayUtc: today,
        rowsReadTotal: 0,
        rowsWrittenTotal: 0,
        workersRequestsTotal: 0,
        rowsReadCron: 0,
        rowsWrittenCron: 0,
        workersRequestsCron: 0,
      };
    }
    if (state.quotaDayUtc !== today) {
      await this.updateSchedulerState({
        quotaDayUtc: today,
        d1RowsReadTotal: 0,
        d1RowsWrittenTotal: 0,
        workersRequestsTotal: 0,
        d1RowsReadCron: 0,
        d1RowsWrittenCron: 0,
        workersRequestsCron: 0,
      });
      return {
        quotaDayUtc: today,
        rowsReadTotal: 0,
        rowsWrittenTotal: 0,
        workersRequestsTotal: 0,
        rowsReadCron: 0,
        rowsWrittenCron: 0,
        workersRequestsCron: 0,
      };
    }
    return {
      quotaDayUtc: state.quotaDayUtc ?? today,
      rowsReadTotal: state.d1RowsReadTotal ?? 0,
      rowsWrittenTotal: state.d1RowsWrittenTotal ?? 0,
      workersRequestsTotal: state.workersRequestsTotal ?? 0,
      rowsReadCron: state.d1RowsReadCron ?? 0,
      rowsWrittenCron: state.d1RowsWrittenCron ?? 0,
      workersRequestsCron: state.workersRequestsCron ?? 0,
    };
  }

  async flushQuotaUsage(
    source: "cron" | "api",
    delta: { reads: number; writes: number; requests: number },
  ): Promise<void> {
    const reads = Math.max(0, Math.floor(delta.reads));
    const writes = Math.max(0, Math.floor(delta.writes));
    const requests = Math.max(0, Math.floor(delta.requests));
    if (reads === 0 && writes === 0 && requests === 0) return;

    await this.getQuotaSnapshot();
    if (source === "cron") {
      await this.db.run(sql`
        UPDATE scheduler_state
        SET
          d1_rows_read_total = d1_rows_read_total + ${reads},
          d1_rows_written_total = d1_rows_written_total + ${writes},
          workers_requests_total = workers_requests_total + ${requests},
          d1_rows_read_cron = d1_rows_read_cron + ${reads},
          d1_rows_written_cron = d1_rows_written_cron + ${writes},
          workers_requests_cron = workers_requests_cron + ${requests}
        WHERE id = 1
      `);
      return;
    }
    await this.db.run(sql`
      UPDATE scheduler_state
      SET
        d1_rows_read_total = d1_rows_read_total + ${reads},
        d1_rows_written_total = d1_rows_written_total + ${writes},
        workers_requests_total = workers_requests_total + ${requests}
      WHERE id = 1
    `);
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

  /** True when at least one of Esplora/Mempool is not in 429 backoff. */
  hasAvailableChainProvider(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
  ): boolean {
    return !this.isProviderInBackoff(state, "esplora") || !this.isProviderInBackoff(state, "mempool");
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

  /** Pending expand candidates for one flagged hacker (self + hop-1 downstream). */
  async getCrawlEnqueueCandidates(hacker: string, limit: number, maxDepth: number) {
    if (limit <= 0) return [];
    const out: { address: string }[] = [];
    const seen = new Set<string>();

    const hackerRow = await this.getAddress(hacker);
    if (hackerRow?.isFlaggedHacker) {
      const status = hackerRow.expandStatus ?? "pending";
      if (status === "pending" || status === "backfilling") {
        out.push({ address: hacker });
        seen.add(hacker);
      }
    }

    if (out.length < limit && maxDepth > 1) {
      const hop1 = await this.db
        .select({ address: addresses.address })
        .from(addresses)
        .innerJoin(
          edges,
          and(
            eq(edges.fromAddress, hacker),
            eq(edges.toAddress, addresses.address),
            eq(edges.direction, "out_from_hacker"),
          ),
        )
        .where(
          and(
            eq(addresses.expandStatus, "pending"),
            eq(addresses.hopFromHacker, 1),
            sql`${addresses.hopFromHacker} < ${maxDepth}`,
          ),
        )
        .orderBy(asc(addresses.lastSeenAt))
        .limit(limit - out.length)
        .all();
      for (const row of hop1) {
        if (!seen.has(row.address)) {
          out.push(row);
          seen.add(row.address);
        }
      }
    }

    return out;
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

  /** Reset in-flight expand scheduling states so cron can re-enqueue after clear-queue. */
  async resetStuckExpandStatuses(): Promise<number> {
    const result = await this.db
      .update(addresses)
      .set({ expandStatus: "pending" })
      .where(or(eq(addresses.expandStatus, "queued"), eq(addresses.expandStatus, "expanding")))
      .run();
    return changesCount(result as { changes?: number; meta?: { changes?: number } });
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
    const result = {
      victimCount: 0,
      hackerCount: 0,
      totalInSats: 0,
      totalOutSats: 0,
      lastJobAt: null as string | null,
      btcUsdPrice: null as number | null,
      btcUsdPriceAt: null as string | null,
    };
    try {
      const victims = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(addresses)
        .where(eq(addresses.role, "victim"))
        .get();
      result.victimCount = victims?.count ?? 0;
    } catch (err) {
      console.error("getStats victimCount failed", err);
    }
    try {
      const hackers = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(addresses)
        .where(and(eq(addresses.isFlaggedHacker, true), gt(addresses.totalReceivedSats, 0)))
        .get();
      result.hackerCount = hackers?.count ?? 0;
    } catch (err) {
      console.error("getStats hackerCount failed", err);
    }
    try {
      const totalIn = await this.db
        .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
        .from(edges)
        .where(eq(edges.direction, "in_to_hacker"))
        .get();
      result.totalInSats = totalIn?.total ?? 0;
    } catch (err) {
      console.error("getStats totalInSats failed", err);
    }
    try {
      const totalOut = await this.db
        .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
        .from(edges)
        .where(eq(edges.direction, "out_from_hacker"))
        .get();
      result.totalOutSats = totalOut?.total ?? 0;
    } catch (err) {
      console.error("getStats totalOutSats failed", err);
    }
    try {
      const lastJob = await this.db
        .select()
        .from(jobs)
        .where(ne(jobs.status, "pending"))
        .orderBy(desc(jobs.id))
        .limit(1)
        .get();
      result.lastJobAt = lastJob?.createdAt ?? null;
    } catch (err) {
      console.error("getStats lastJobAt failed", err);
    }
    try {
      const scheduler = await this.getSchedulerState();
      result.btcUsdPrice = scheduler?.btcUsdPrice ?? null;
      result.btcUsdPriceAt = scheduler?.btcUsdPriceAt ?? null;
    } catch (err) {
      console.error("getStats btcUsdPrice failed", err);
    }
    return result;
  }

  /** Distinct victims with in_to_hacker edges into this hacker. */
  async getExistingAddressSet(addressList: string[]): Promise<Set<string>> {
    const unique = [...new Set(addressList)].filter(Boolean);
    if (unique.length === 0) return new Set();
    const existing = new Set<string>();
    for (const chunk of chunkArray(unique, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const rows = await this.db
        .select({ address: addresses.address })
        .from(addresses)
        .where(inArray(addresses.address, chunk))
        .all();
      for (const row of rows) existing.add(row.address);
    }
    return existing;
  }

  /** Walk backward along out_from_hacker edges to root flagged hackers. */
  async findRootHackersForSpender(address: string): Promise<string[]> {
    const map = await this.findRootHackersForSpenders([address]);
    return map.get(address) ?? [];
  }

  /** Batch root-hacker lookup with shared D1 read cache across seeds. */
  async findRootHackersForSpenders(addresses: string[]): Promise<Map<string, string[]>> {
    const seeds = [...new Set(addresses.filter(Boolean))];
    const result = new Map<string, string[]>();
    if (seeds.length === 0) return result;

    const addressRowCache = new Map<string, Awaited<ReturnType<Store["getAddress"]>>>();
    const inboundCache = new Map<string, Array<{ from: string }>>();

    const getAddr = async (addr: string) => {
      let row = addressRowCache.get(addr);
      if (row === undefined) {
        row = await this.getAddress(addr);
        addressRowCache.set(addr, row);
      }
      return row;
    };

    const getInbound = async (addr: string) => {
      let rows = inboundCache.get(addr);
      if (rows === undefined) {
        rows = await this.db
          .select({ from: edges.fromAddress })
          .from(edges)
          .where(and(eq(edges.toAddress, addr), eq(edges.direction, "out_from_hacker")))
          .all();
        inboundCache.set(addr, rows);
      }
      return rows;
    };

    for (const seed of seeds) {
      const seen = new Set<string>();
      const queue = [seed];
      const roots = new Set<string>();
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const row = await getAddr(cur);
        if (row?.isFlaggedHacker) {
          roots.add(cur);
          continue;
        }
        const ins = await getInbound(cur);
        for (const inbound of ins) {
          if (!seen.has(inbound.from)) queue.push(inbound.from);
        }
      }
      result.set(seed, [...roots]);
    }
    return result;
  }

  async getExistingInToHackerEdgeKeys(
    rows: Array<{ fromAddress: string; toAddress: string; txid: string }>,
  ): Promise<Set<string>> {
    const keys = new Set<string>();
    if (rows.length === 0) return keys;
    const txids = [...new Set(rows.map((row) => row.txid))];
    for (const txidChunk of chunkArray(txids, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const existing = await this.db
        .select({
          fromAddress: edges.fromAddress,
          toAddress: edges.toAddress,
          txid: edges.txid,
        })
        .from(edges)
        .where(and(inArray(edges.txid, txidChunk), eq(edges.direction, "in_to_hacker")))
        .all();
      for (const row of existing) {
        keys.add(`${row.fromAddress}|${row.toAddress}|${row.txid}`);
      }
    }
    return keys;
  }

  recordRecentHackerActivity(address: string, delta: RecentHackerActivityDelta): void {
    if (!address) return;
    if (!this.recentHackerActivityBuffer) {
      this.recentHackerActivityBuffer = new Map();
    }
    const prev = this.recentHackerActivityBuffer.get(address);
    const atCandidates = [prev?.at, delta.at].filter((v): v is string => Boolean(v));
    const at =
      atCandidates.length === 0
        ? undefined
        : atCandidates.reduce((max, cur) => (cur > max ? cur : max));
    this.recentHackerActivityBuffer.set(address, {
      victims: (prev?.victims ?? 0) + (delta.victims ?? 0),
      downstream: (prev?.downstream ?? 0) + (delta.downstream ?? 0),
      at,
    });
  }

  clearRecentHackerActivityBuffer(): void {
    this.recentHackerActivityBuffer = undefined;
  }

  async getRecentHackersActivity(): Promise<RecentHackerEntry[]> {
    const row = await this.db
      .select({ json: schedulerState.recentHackersJson })
      .from(schedulerState)
      .where(eq(schedulerState.id, 1))
      .get();
    return parseRecentHackersJson(row?.json);
  }

  async flushRecentHackerActivity(limit: number): Promise<boolean> {
    const buffer = this.recentHackerActivityBuffer;
    if (!buffer || buffer.size === 0) {
      this.clearRecentHackerActivityBuffer();
      return false;
    }

    const row = await this.db
      .select({ json: schedulerState.recentHackersJson })
      .from(schedulerState)
      .where(eq(schedulerState.id, 1))
      .get();
    const existing = parseRecentHackersJson(row?.json);
    const merged = mergeRecentHackerActivity(existing, buffer, limit);
    this.clearRecentHackerActivityBuffer();

    if (recentHackersEqual(existing, merged)) return false;

    await this.db
      .update(schedulerState)
      .set({ recentHackersJson: serializeRecentHackers(merged) })
      .where(eq(schedulerState.id, 1))
      .run();
    return true;
  }

  async bumpHackerGraphActivity(hackerAddresses: string[], at?: string): Promise<void> {
    const ts = at ?? now();
    const unique = [...new Set(hackerAddresses)].filter(Boolean);
    if (unique.length === 0) return;
    for (const hacker of unique) {
      const row = await this.getAddress(hacker);
      if (!row?.isFlaggedHacker) continue;
      const existing = row.lastGraphActivityAt;
      const next = existing != null && existing > ts ? existing : ts;
      if (existing === next) continue;
      await this.db
        .update(addresses)
        .set({ lastGraphActivityAt: next })
        .where(eq(addresses.address, hacker))
        .run();
    }
  }

  /**
   * Recent victim/downstream activity counts per hacker.
   * Internal-only: uses an expensive recursive CTE on D1 — do not call from hot API read paths.
   * Reserved for future cached/offline use; `/api/hackers` uses `lastGraphActivityAt` instead.
   */
  async getHackerActivitySummary(
    hackerAddresses: string[],
    sinceIso: string,
  ): Promise<Map<string, { recentVictimCount: number; recentDownstreamCount: number }>> {
    const result = new Map<string, { recentVictimCount: number; recentDownstreamCount: number }>();
    for (const hacker of hackerAddresses) {
      result.set(hacker, { recentVictimCount: 0, recentDownstreamCount: 0 });
    }
    if (hackerAddresses.length === 0) return result;

    for (const chunk of chunkArray(hackerAddresses, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const victimRows = await this.db
        .select({
          hacker: edges.toAddress,
          count: sql<number>`count(distinct ${edges.fromAddress})`,
        })
        .from(edges)
        .innerJoin(addresses, eq(edges.fromAddress, addresses.address))
        .where(
          and(
            inArray(edges.toAddress, chunk),
            eq(edges.direction, "in_to_hacker"),
            eq(addresses.role, "victim"),
            isNotNull(addresses.firstSeenAt),
            gte(addresses.firstSeenAt, sinceIso),
          ),
        )
        .groupBy(edges.toAddress)
        .all();
      for (const row of victimRows) {
        const entry = result.get(row.hacker);
        if (entry) entry.recentVictimCount = row.count ?? 0;
      }
    }

    for (const chunk of chunkArray(hackerAddresses, D1_IN_CLAUSE_CHUNK_SIZE)) {
      if (chunk.length === 0) continue;
      const inList = sql.join(
        chunk.map((address) => sql`${address}`),
        sql`, `,
      );
      const downstreamRows = (await this.db.all(sql`
        WITH RECURSIVE tree(hacker_root, addr) AS (
          SELECT address, address FROM addresses WHERE address IN (${inList})
          UNION ALL
          SELECT t.hacker_root, e.to_address
          FROM edges e
          INNER JOIN tree t ON e.from_address = t.addr
          WHERE e.direction = 'out_from_hacker'
        )
        SELECT t.hacker_root AS hacker, COUNT(*) AS count
        FROM tree t
        INNER JOIN addresses a ON a.address = t.addr
        WHERE a.role = 'downstream'
          AND a.first_seen_at IS NOT NULL
          AND a.first_seen_at >= ${sinceIso}
          AND t.addr != t.hacker_root
        GROUP BY t.hacker_root
      `)) as Array<{ hacker: string; count: number }>;
      for (const row of downstreamRows) {
        const entry = result.get(row.hacker);
        if (entry) entry.recentDownstreamCount = Number(row.count) ?? 0;
      }
    }

    return result;
  }

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

  /** Downstream-role addresses that also have in_to_hacker edges (victim pollution). */
  async listVictimRolePollution(opts?: { address?: string }): Promise<string[]> {
    const conditions = [eq(addresses.role, "downstream")];
    if (opts?.address) {
      conditions.push(eq(addresses.address, opts.address));
    }
    const downstreamRows = await this.db
      .select({ address: addresses.address })
      .from(addresses)
      .where(and(...conditions))
      .all();
    if (downstreamRows.length === 0) return [];

    const polluted: string[] = [];
    const addrList = downstreamRows.map((row) => row.address);
    for (const chunk of chunkArray(addrList, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const rows = await this.db
        .selectDistinct({ fromAddress: edges.fromAddress })
        .from(edges)
        .where(and(inArray(edges.fromAddress, chunk), eq(edges.direction, "in_to_hacker")))
        .all();
      for (const row of rows) polluted.push(row.fromAddress);
    }
    return polluted;
  }

  async repairVictimRolePollution(opts?: {
    address?: string;
    dryRun?: boolean;
  }): Promise<{ dryRun: boolean; scanned: number; repaired: string[]; jobsCancelled: number }> {
    const dryRun = opts?.dryRun === true;
    const polluted = await this.listVictimRolePollution({ address: opts?.address });
    if (dryRun) {
      return { dryRun: true, scanned: polluted.length, repaired: [], jobsCancelled: 0 };
    }

    const repaired: string[] = [];
    let jobsCancelled = 0;
    for (const address of polluted) {
      await this.upsertAddress({ address, role: "victim", hopFromHacker: null });
      jobsCancelled += await this.deleteActiveJobsForAddress(address);
      repaired.push(address);
    }
    return { dryRun: false, scanned: polluted.length, repaired, jobsCancelled };
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
