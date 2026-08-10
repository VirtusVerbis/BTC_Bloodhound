import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { normalizeBitcoinAddress } from "../util/address.js";

export interface AddHackerResult {
  address: string;
  upserted: true;
  enqueuedBackfill: boolean;
}

export interface RemoveHackerResult {
  address: string;
  unflagged: boolean;
  jobsCancelled: number;
  victimsPruned: number;
  downstreamPruned: number;
  edgesRemoved: number;
  message?: string;
}

export interface ClearQueueResult {
  deleted: number;
  pending: number;
  running: number;
}

export async function addHacker(
  store: Store,
  opts: { address: string; label?: string | null },
): Promise<AddHackerResult> {
  const address = normalizeBitcoinAddress(opts.address);
  if (!address) {
    throw new Error(`Invalid Bitcoin address: ${opts.address}`);
  }

  await store.upsertAddress({
    address,
    role: "hacker",
    isFlaggedHacker: true,
    hopFromHacker: 0,
    source: "ops",
    label: opts.label ?? undefined,
  });

  const jobId = await store.enqueueJobIfAbsent(
    "backfill_hacker_address",
    { address },
    JOB_PRIORITY.BACKFILL_HACKER,
    undefined,
    { address },
  );

  return { address, upserted: true, enqueuedBackfill: jobId != null };
}

export async function removeHacker(
  store: Store,
  rawAddress: string,
  opts: { pruneExclusive?: boolean } = {},
): Promise<RemoveHackerResult> {
  const pruneExclusive = opts.pruneExclusive !== false;
  const address = normalizeBitcoinAddress(rawAddress);
  if (!address) {
    throw new Error(`Invalid Bitcoin address: ${rawAddress}`);
  }

  const existing = await store.getAddress(address);
  if (!existing?.isFlaggedHacker) {
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

  const victims = pruneExclusive ? await store.listVictimAddressesForHacker(address) : [];
  const downstream = pruneExclusive ? await store.collectDownstreamAddresses(address) : [];
  const downstreamSet = new Set(downstream);

  await store.upsertAddress({ address, isFlaggedHacker: false });

  const jobsCancelled = await store.deleteActiveJobsForAddress(address);

  let victimsPruned = 0;
  let downstreamPruned = 0;
  let edgesRemoved = 0;

  if (pruneExclusive) {
    edgesRemoved += await store.deleteEdgesTouchingAddress(address);

    const pruned = new Set<string>();

    for (const victim of victims) {
      if (victim === address || pruned.has(victim)) continue;
      const otherLinks = await store.countInToHackerEdgesToOtherFlagged(victim, address);
      if (otherLinks > 0) continue;
      const row = await store.getAddress(victim);
      if (!row || row.isFlaggedHacker) continue;
      edgesRemoved += await store.deleteEdgesTouchingAddress(victim);
      await store.deleteAddress(victim);
      pruned.add(victim);
      victimsPruned += 1;
    }

    for (const candidate of downstream) {
      if (candidate === address || pruned.has(candidate)) continue;
      const row = await store.getAddress(candidate);
      if (!row) continue;
      if (row.isFlaggedHacker) continue;
      if (await store.hasEdgeWithOtherFlaggedHacker(candidate, address)) continue;
      if (await store.hasOutFromHackerInboundOutside(candidate, downstreamSet, address)) continue;

      edgesRemoved += await store.deleteEdgesTouchingAddress(candidate);
      await store.deleteAddress(candidate);
      pruned.add(candidate);
      downstreamPruned += 1;
    }
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

export async function clearQueue(store: Store): Promise<ClearQueueResult> {
  return store.deleteActiveJobs();
}
