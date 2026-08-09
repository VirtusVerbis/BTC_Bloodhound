import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
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
  type Edge,
  type Job,
} from "./schema.js";

const INGEST_JOB_TYPES = [
  "backfill_hacker_address",
  "audit_hacker_backfill",
  "expand_downstream",
] as const;

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

  const processedIndex = payload.processedIndex;
  if (typeof processedIndex === "number" && processedIndex > 0) return true;

  if (payload.pagesExhausted === false) {
    const pagesFetched = payload.pagesFetched;
    if (typeof pagesFetched === "number" && pagesFetched > 0) return true;
    if (payload.chainCursor != null) return true;
  }

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

export class Store {
  constructor(public db: Db) {}

  async upsertAddress(data: {
    address: string;
    role?: string;
    label?: string | null;
    source?: string;
    isFlaggedHacker?: boolean;
    hopFromHacker?: number | null;
    expandStatus?: string;
    totalReceivedSats?: number;
    liveBalanceSats?: number | null;
    liveBalanceAt?: string | null;
  }) {
    const existing = await this.db.select().from(addresses).where(eq(addresses.address, data.address)).get();
    const ts = now();
    if (existing) {
      const role =
        existing.role === "hacker" && data.role === "victim"
          ? existing.role
          : data.role ?? existing.role;
      await this.db
        .update(addresses)
        .set({
          role,
          label: data.label ?? existing.label,
          source: data.source ?? existing.source,
          isFlaggedHacker: data.isFlaggedHacker ?? existing.isFlaggedHacker,
          hopFromHacker: data.hopFromHacker ?? existing.hopFromHacker,
          expandStatus: data.expandStatus ?? existing.expandStatus,
          totalReceivedSats: data.totalReceivedSats ?? existing.totalReceivedSats,
          liveBalanceSats: data.liveBalanceSats ?? existing.liveBalanceSats,
          liveBalanceAt: data.liveBalanceAt ?? existing.liveBalanceAt,
          lastSeenAt: ts,
        })
        .where(eq(addresses.address, data.address))
        .run();
    } else {
      await this.db
        .insert(addresses)
        .values({
          address: data.address,
          role: data.role ?? "unknown",
          label: data.label ?? null,
          source: data.source ?? "derived",
          isFlaggedHacker: data.isFlaggedHacker ?? false,
          createdAt: ts,
          firstSeenAt: ts,
          lastSeenAt: ts,
          hopFromHacker: data.hopFromHacker ?? null,
          expandStatus: data.expandStatus ?? "pending",
          totalReceivedSats: data.totalReceivedSats ?? 0,
          liveBalanceSats: data.liveBalanceSats ?? null,
          liveBalanceAt: data.liveBalanceAt ?? null,
        })
        .run();
    }
  }

  async getAddress(address: string) {
    return await this.db.select().from(addresses).where(eq(addresses.address, address)).get();
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

  async upsertEdge(data: {
    fromAddress: string;
    toAddress: string;
    txid: string;
    amountSats: number;
    blockTime?: string | null;
    hopFromHacker?: number | null;
    direction: string;
  }) {
    const existing = await this.db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.fromAddress, data.fromAddress),
          eq(edges.toAddress, data.toAddress),
          eq(edges.txid, data.txid),
        ),
      )
      .get();
    if (existing) {
      await this.db
        .update(edges)
        .set({
          amountSats: data.amountSats,
          blockTime: data.blockTime ?? existing.blockTime,
          hopFromHacker: data.hopFromHacker ?? existing.hopFromHacker,
          direction: data.direction,
        })
        .where(eq(edges.id, existing.id))
        .run();
    } else {
      await this.db.insert(edges).values(data).run();
    }
    if (data.direction === "in_to_hacker") {
      await this.recalcTotalReceived(data.toAddress);
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

  async resolveHackTiming(edgeList: Edge[]) {
    type Candidate = {
      txid: string;
      sortHeight: number | null;
      sortTime: string | null;
    };

    const candidates: Candidate[] = [];
    for (const e of edgeList) {
      const tx = await this.getTransaction(e.txid);
      if (tx?.blockHeight != null || tx?.blockTime != null || e.blockTime) {
        candidates.push({
          txid: e.txid,
          sortHeight: tx?.blockHeight ?? null,
          sortTime: tx?.blockTime ?? e.blockTime ?? null,
        });
      }
    }

    if (candidates.length === 0) {
      return { hackOccurredAt: null as string | null, hackBlockHeight: null as number | null };
    }

    candidates.sort((a, b) => {
      if (a.sortHeight != null && b.sortHeight != null) return a.sortHeight - b.sortHeight;
      if (a.sortHeight != null) return -1;
      if (b.sortHeight != null) return 1;
      return (a.sortTime ?? "").localeCompare(b.sortTime ?? "");
    });

    const earliest = candidates[0]!;
    const tx = await this.getTransaction(earliest.txid);
    const hackBlockHeight = tx?.blockHeight ?? earliest.sortHeight ?? null;
    let hackOccurredAt = tx?.blockTime ?? earliest.sortTime ?? null;
    if (!hackOccurredAt && hackBlockHeight != null) {
      hackOccurredAt = await this.getBlockTimeByHeight(hackBlockHeight);
    }

    return { hackOccurredAt, hackBlockHeight };
  }

  async getAddressDetail(address: string) {
    const addr = await this.getAddress(address);
    if (!addr) return null;
    const incoming = await this.getEdgesToAddress(address);
    const outgoing = await this.getEdgesFromAddress(address);
    const allEdges = [...incoming, ...outgoing];
    const relatedTxs = [];
    for (const e of allEdges) {
      const tx = await this.getTransaction(e.txid);
      relatedTxs.push({
        txid: e.txid,
        blockTime: tx?.blockTime ?? e.blockTime ?? null,
        amountSats: e.amountSats,
        direction: e.fromAddress === address ? "out" : "in",
        counterparty: e.fromAddress === address ? e.toAddress : e.fromAddress,
      });
    }
    relatedTxs.sort((a, b) => (b.blockTime ?? "").localeCompare(a.blockTime ?? ""));
    const totalSent = outgoing.reduce((s, e) => s + e.amountSats, 0);
    const { hackOccurredAt, hackBlockHeight } = await this.resolveHackTiming(allEdges);
    return { address: addr, totalSent, relatedTxs, hackOccurredAt, hackBlockHeight };
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

  async enqueueJob(type: string, payload: Record<string, unknown>, priority: number, runAfter?: string) {
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
          sql`${jobs.payloadJson} LIKE ${`%"address":"${address}"%`}`,
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
    const row = await this.db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
    const windowStartMs = row ? new Date(row.windowStart).getTime() : 0;
    const inWindow = row != null && ts - windowStartMs < windowMs;

    if (!inWindow) {
      const start = new Date(ts).toISOString();
      if (row) {
        await this.db
          .update(rateLimits)
          .set({ windowStart: start, count: 1 })
          .where(eq(rateLimits.key, key))
          .run();
      } else {
        await this.db.insert(rateLimits).values({ key, windowStart: start, count: 1 }).run();
      }
      return { allowed: true, retryAfterSec: 0 };
    }

    if (row.count >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((windowStartMs + windowMs - ts) / 1000));
      return { allowed: false, retryAfterSec };
    }

    await this.db
      .update(rateLimits)
      .set({ count: row.count + 1 })
      .where(eq(rateLimits.key, key))
      .run();
    return { allowed: true, retryAfterSec: 0 };
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
      const cont = candidates.find((j) => isIngestContinuation(j.payloadJson));
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
      .set({ status: "done", lastError: null, completedAt: now() })
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

  async resetRunningJobs(): Promise<number> {
    const result = await this.db
      .update(jobs)
      .set({ status: "pending", startedAt: null })
      .where(eq(jobs.status, "running"))
      .run();
    return changesCount(result as { changes?: number; meta?: { changes?: number } });
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

  async getSchedulerState() {
    return await this.db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
  }

  async updateSchedulerState(data: {
    nextProviderCallAt?: string;
    lastProviderUsed?: string;
    lastProviderSuccessAt?: string;
    lastApiThresholdAt?: string;
    apiThresholdCount?: number;
    backfillHealAuditIndex?: number;
    hackerPollIndex?: number;
    rateLimitMs?: number;
    btcUsdPrice?: number;
    btcUsdPriceAt?: string;
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

  async getBtcUsdPrice(): Promise<{ usd: number; at: string } | null> {
    const state = await this.getSchedulerState();
    if (state?.btcUsdPrice == null || !state.btcUsdPriceAt) return null;
    return { usd: state.btcUsdPrice, at: state.btcUsdPriceAt };
  }

  async recordApiThreshold() {
    const state = await this.getSchedulerState();
    await this.db
      .update(schedulerState)
      .set({
        lastApiThresholdAt: now(),
        apiThresholdCount: (state?.apiThresholdCount ?? 0) + 1,
      })
      .where(eq(schedulerState.id, 1))
      .run();
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

  async getSourceSync(source: string) {
    return await this.db.select().from(sourceSyncState).where(eq(sourceSyncState.source, source)).get();
  }

  async upsertSourceSync(source: string, data: { lastAddressCount?: number; lastContentHash?: string }) {
    const ts = now();
    const existing = await this.getSourceSync(source);
    if (existing) {
      await this.db
        .update(sourceSyncState)
        .set({ lastSyncAt: ts, ...data })
        .where(eq(sourceSyncState.source, source))
        .run();
    } else {
      await this.db.insert(sourceSyncState).values({ source, lastSyncAt: ts, ...data }).run();
    }
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

  async getMonitoringStatus(staleSec: number, thresholdCooldownSec: number) {
    const scheduler = await this.getSchedulerState();
    const lastChainApiAt = scheduler?.lastProviderSuccessAt ?? null;
    const lastApiThresholdAt = scheduler?.lastApiThresholdAt ?? null;
    const apiThresholdCount = scheduler?.apiThresholdCount ?? 0;
    const apiThresholdExceeded =
      lastApiThresholdAt != null &&
      Date.now() - new Date(lastApiThresholdAt).getTime() <= thresholdCooldownSec * 1000;

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
}
