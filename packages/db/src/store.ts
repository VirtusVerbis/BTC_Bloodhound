import { and, asc, desc, eq, gt, gte, isNotNull, like, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import {
  addresses,
  addressSubmissions,
  edges,
  jobs,
  schedulerState,
  sourceSyncState,
  syncState,
  transactions,
  type Edge,
} from "./schema.js";

const now = () => new Date().toISOString();

export class Store {
  constructor(public db: Db) {}

  upsertAddress(data: {
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
    const existing = this.db.select().from(addresses).where(eq(addresses.address, data.address)).get();
    const ts = now();
    if (existing) {
      const role =
        existing.role === "hacker" && data.role === "victim"
          ? existing.role
          : data.role ?? existing.role;
      this.db
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
      this.db
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

  getAddress(address: string) {
    return this.db.select().from(addresses).where(eq(addresses.address, address)).get();
  }

  listHackers(q?: string) {
    const base = eq(addresses.isFlaggedHacker, true);
    if (q?.trim()) {
      const pattern = `%${q.trim()}%`;
      return this.db
        .select()
        .from(addresses)
        .where(and(base, or(like(addresses.address, pattern), like(addresses.label, pattern))))
        .orderBy(desc(addresses.totalReceivedSats))
        .all();
    }
    return this.db
      .select()
      .from(addresses)
      .where(base)
      .orderBy(desc(addresses.totalReceivedSats))
      .all();
  }

  upsertEdge(data: {
    fromAddress: string;
    toAddress: string;
    txid: string;
    amountSats: number;
    blockTime?: string | null;
    hopFromHacker?: number | null;
    direction: string;
  }) {
    const existing = this.db
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
      if (data.blockTime != null) {
        this.db.update(edges).set({ blockTime: data.blockTime }).where(eq(edges.id, existing.id)).run();
      }
    } else {
      this.db.insert(edges).values(data).run();
    }
    if (data.direction === "in_to_hacker") {
      this.recalcTotalReceived(data.toAddress);
    }
  }

  recalcTotalReceived(hackerAddress: string) {
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
      .from(edges)
      .where(and(eq(edges.toAddress, hackerAddress), eq(edges.direction, "in_to_hacker")))
      .get();
    this.db
      .update(addresses)
      .set({ totalReceivedSats: row?.total ?? 0 })
      .where(eq(addresses.address, hackerAddress))
      .run();
  }

  upsertTransaction(data: { txid: string; blockHeight?: number | null; blockTime?: string | null; feeSats?: number | null }) {
    const existing = this.db.select().from(transactions).where(eq(transactions.txid, data.txid)).get();
    if (existing) {
      this.db
        .update(transactions)
        .set({
          blockHeight: data.blockHeight ?? existing.blockHeight,
          blockTime: data.blockTime ?? existing.blockTime,
          feeSats: data.feeSats ?? existing.feeSats,
        })
        .where(eq(transactions.txid, data.txid))
        .run();
    } else {
      this.db.insert(transactions).values(data).run();
    }
  }

  getEdgesForHacker(hacker: string) {
    return this.db
      .select()
      .from(edges)
      .where(or(eq(edges.fromAddress, hacker), eq(edges.toAddress, hacker)))
      .all();
  }

  getEdgesToAddress(address: string) {
    return this.db.select().from(edges).where(eq(edges.toAddress, address)).all();
  }

  getEdgesFromAddress(address: string) {
    return this.db.select().from(edges).where(eq(edges.fromAddress, address)).all();
  }

  getTransaction(txid: string) {
    return this.db.select().from(transactions).where(eq(transactions.txid, txid)).get();
  }

  getVictimStats(hacker: string, minEdgeSats?: number) {
    const conditions = [eq(edges.toAddress, hacker), eq(edges.direction, "in_to_hacker")];
    if (minEdgeSats != null) {
      conditions.push(gte(edges.amountSats, minEdgeSats));
    }
    const row = this.db
      .select({
        count: sql<number>`count(distinct ${edges.fromAddress})`,
        total: sql<number>`coalesce(sum(${edges.amountSats}), 0)`,
      })
      .from(edges)
      .where(and(...conditions))
      .get();
    return { childCount: row?.count ?? 0, totalSats: row?.total ?? 0 };
  }

  listVictimsForHacker(hacker: string, limit = 100) {
    return this.db
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

  getBlockTimeByHeight(blockHeight: number) {
    const row = this.db
      .select({ blockTime: transactions.blockTime })
      .from(transactions)
      .where(and(eq(transactions.blockHeight, blockHeight), isNotNull(transactions.blockTime)))
      .limit(1)
      .get();
    return row?.blockTime ?? null;
  }

  resolveHackTiming(edgeList: Edge[]) {
    type Candidate = {
      txid: string;
      sortHeight: number | null;
      sortTime: string | null;
    };

    const candidates: Candidate[] = edgeList.map((e) => {
      const tx = this.getTransaction(e.txid);
      return {
        txid: e.txid,
        sortHeight: tx?.blockHeight ?? null,
        sortTime: tx?.blockTime ?? e.blockTime ?? null,
      };
    }).filter((c) => c.sortHeight != null || c.sortTime);

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
    const tx = this.getTransaction(earliest.txid);
    const hackBlockHeight = tx?.blockHeight ?? earliest.sortHeight ?? null;
    let hackOccurredAt = tx?.blockTime ?? earliest.sortTime ?? null;
    if (!hackOccurredAt && hackBlockHeight != null) {
      hackOccurredAt = this.getBlockTimeByHeight(hackBlockHeight);
    }

    return { hackOccurredAt, hackBlockHeight };
  }

  getAddressDetail(address: string) {
    const addr = this.getAddress(address);
    if (!addr) return null;
    const incoming = this.getEdgesToAddress(address);
    const outgoing = this.getEdgesFromAddress(address);
    const allEdges = [...incoming, ...outgoing];
    const relatedTxs = allEdges
      .map((e) => {
        const tx = this.getTransaction(e.txid);
        return {
          txid: e.txid,
          blockTime: tx?.blockTime ?? e.blockTime ?? null,
          amountSats: e.amountSats,
          direction: e.fromAddress === address ? "out" : "in",
          counterparty: e.fromAddress === address ? e.toAddress : e.fromAddress,
        };
      })
      .sort((a, b) => (b.blockTime ?? "").localeCompare(a.blockTime ?? ""));
    const totalSent = outgoing.reduce((s, e) => s + e.amountSats, 0);
    const { hackOccurredAt, hackBlockHeight } = this.resolveHackTiming(allEdges);
    return { address: addr, totalSent, relatedTxs, hackOccurredAt, hackBlockHeight };
  }

  listHackersForVictim(victim: string, minEdgeSats?: number) {
    const conditions = [
      eq(edges.fromAddress, victim),
      eq(edges.direction, "in_to_hacker"),
    ];
    if (minEdgeSats != null) {
      conditions.push(gte(edges.amountSats, minEdgeSats));
    }
    const rows = this.db
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
        const hacker = this.getAddress(row.hackerAddress);
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

  enqueueJob(type: string, payload: Record<string, unknown>, priority: number, runAfter?: string) {
    const result = this.db
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
    return Number(result.lastInsertRowid);
  }

  hasPendingJob(type: string, address?: string) {
    if (!address) {
      return !!this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, type), or(eq(jobs.status, "pending"), eq(jobs.status, "running"))))
        .get();
    }
    const pending = this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          or(eq(jobs.status, "pending"), eq(jobs.status, "running")),
          like(jobs.payloadJson, `%"address":"${address}"%`),
        ),
      )
      .get();
    return !!pending;
  }

  claimNextJob() {
    const ts = now();
    const job = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, ts)))
      .orderBy(desc(jobs.priority), asc(jobs.runAfter))
      .limit(1)
      .get();
    if (!job) return null;
    this.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id)).run();
    return job;
  }

  completeJob(id: number) {
    this.db.update(jobs).set({ status: "done", lastError: null }).where(eq(jobs.id, id)).run();
  }

  failJob(id: number, error: string, runAfter?: string) {
    const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    this.db
      .update(jobs)
      .set({
        status: "pending",
        attempts: (job?.attempts ?? 0) + 1,
        lastError: error,
        runAfter: runAfter ?? now(),
      })
      .where(eq(jobs.id, id))
      .run();
  }

  getJob(id: number) {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  countPendingJobsBefore(priority: number, runAfter: string) {
    const row = this.db
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

  getQueueDepth() {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.status, "pending"))
      .get();
    return row?.count ?? 0;
  }

  getSchedulerState() {
    return this.db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
  }

  updateSchedulerState(data: { nextProviderCallAt?: string; lastProviderUsed?: string; rateLimitMs?: number }) {
    this.db
      .update(schedulerState)
      .set(data)
      .where(eq(schedulerState.id, 1))
      .run();
  }

  getSyncState(address: string) {
    return this.db.select().from(syncState).where(eq(syncState.address, address)).get();
  }

  upsertSyncState(address: string, data: { lastSeenTxid?: string; lastBlockHeight?: number | null }) {
    const existing = this.getSyncState(address);
    const ts = now();
    if (existing) {
      this.db
        .update(syncState)
        .set({
          lastSeenTxid: data.lastSeenTxid ?? existing.lastSeenTxid,
          lastBlockHeight: data.lastBlockHeight ?? existing.lastBlockHeight,
          lastPolledAt: ts,
        })
        .where(eq(syncState.address, address))
        .run();
    } else {
      this.db
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

  getSourceSync(source: string) {
    return this.db.select().from(sourceSyncState).where(eq(sourceSyncState.source, source)).get();
  }

  upsertSourceSync(source: string, data: { lastAddressCount?: number; lastContentHash?: string }) {
    const ts = now();
    const existing = this.getSourceSync(source);
    if (existing) {
      this.db
        .update(sourceSyncState)
        .set({ lastSyncAt: ts, ...data })
        .where(eq(sourceSyncState.source, source))
        .run();
    } else {
      this.db.insert(sourceSyncState).values({ source, lastSyncAt: ts, ...data }).run();
    }
  }

  getCrawlStats() {
    const pending = this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(and(eq(addresses.expandStatus, "pending"), or(eq(addresses.role, "downstream"), eq(addresses.role, "hacker"))))
      .get();
    const expanded = this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(eq(addresses.expandStatus, "expanded"))
      .get();
    const maxHop = this.db
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

  getDownstreamFrontier(limit: number, maxDepth: number) {
    return this.db
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

  setExpandStatus(address: string, status: string) {
    this.db
      .update(addresses)
      .set({ expandStatus: status, lastExpandedAt: now() })
      .where(eq(addresses.address, address))
      .run();
  }

  createSubmission(data: { address: string; submittedBy?: string; reason?: string }) {
    const result = this.db
      .insert(addressSubmissions)
      .values({ ...data, createdAt: now(), status: "pending" })
      .run();
    return Number(result.lastInsertRowid);
  }

  getStats() {
    const victims = this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(eq(addresses.role, "victim"))
      .get();
    const hackers = this.db
      .select({ count: sql<number>`count(*)` })
      .from(addresses)
      .where(eq(addresses.isFlaggedHacker, true))
      .get();
    const totalIn = this.db
      .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
      .from(edges)
      .where(eq(edges.direction, "in_to_hacker"))
      .get();
    const totalOut = this.db
      .select({ total: sql<number>`coalesce(sum(${edges.amountSats}), 0)` })
      .from(edges)
      .where(eq(edges.direction, "out_from_hacker"))
      .get();
    const lastJob = this.db
      .select()
      .from(jobs)
      .where(ne(jobs.status, "pending"))
      .orderBy(desc(jobs.id))
      .limit(1)
      .get();
    return {
      victimCount: victims?.count ?? 0,
      hackerCount: hackers?.count ?? 0,
      totalInSats: totalIn?.total ?? 0,
      totalOutSats: totalOut?.total ?? 0,
      lastJobAt: lastJob?.createdAt ?? null,
    };
  }
}
