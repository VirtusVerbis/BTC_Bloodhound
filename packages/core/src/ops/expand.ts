import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { normalizeBitcoinAddress } from "../util/address.js";

export interface EnqueueExpandDownstreamResult {
  address: string;
  enqueued: boolean;
  jobId: number | null;
  priority: number;
  message?: string;
}

export interface BumpExpandDownstreamResult {
  address: string;
  updated: number;
  jobIds: number[];
  priority: number;
  message?: string;
}

async function buildEnqueueFailureMessage(store: Store, address: string): Promise<string> {
  if (await store.hasPendingJob("expand_downstream", address)) {
    return "expand_downstream job already queued or running for this address";
  }
  if (await store.isQueueSchedulingPaused()) {
    return "queue scheduling is paused (expand_downstream enqueue blocked)";
  }
  return "expand_downstream enqueue skipped (expand caps or queue depth limit)";
}

async function buildBumpFailureMessage(store: Store, address: string): Promise<string> {
  const active = await store.countActiveJobsForAddress("expand_downstream", address);
  if (active === 0) {
    return "no pending or running expand_downstream job for this address";
  }
  return "expand_downstream job is running — retry after continuation appears as pending";
}

export async function enqueueExpandDownstream(
  store: Store,
  opts: { address: string; priority?: number },
): Promise<EnqueueExpandDownstreamResult> {
  const address = normalizeBitcoinAddress(opts.address);
  if (!address) {
    throw new Error(`Invalid Bitcoin address: ${opts.address}`);
  }

  const existing = await store.getAddress(address);
  if (!existing) {
    return {
      address,
      enqueued: false,
      jobId: null,
      priority: opts.priority ?? JOB_PRIORITY.CRON_EXPAND,
      message: "Address not in database",
    };
  }

  const priority = opts.priority ?? JOB_PRIORITY.CRON_EXPAND;
  if (!Number.isFinite(priority) || priority < 1) {
    throw new Error(`Invalid priority: ${opts.priority} (must be a positive number)`);
  }

  const jobId = await store.enqueueJobIfAbsent(
    "expand_downstream",
    { address, ops: true, opsPriority: priority },
    priority,
    undefined,
    { address },
  );

  if (jobId != null) {
    await store.setExpandStatus(address, "queued");
    return { address, enqueued: true, jobId, priority };
  }

  return {
    address,
    enqueued: false,
    jobId: null,
    priority,
    message: await buildEnqueueFailureMessage(store, address),
  };
}

export async function bumpExpandDownstream(
  store: Store,
  opts: { address: string; priority?: number },
): Promise<BumpExpandDownstreamResult> {
  const address = normalizeBitcoinAddress(opts.address);
  if (!address) {
    throw new Error(`Invalid Bitcoin address: ${opts.address}`);
  }

  const priority = opts.priority ?? JOB_PRIORITY.PROCESS_TX_REBUILD;
  if (!Number.isFinite(priority) || priority < 1) {
    throw new Error(`Invalid priority: ${opts.priority} (must be a positive number)`);
  }

  const { updated, jobIds } = await store.bumpPendingExpandDownstream(address, priority);
  if (updated > 0) {
    return { address, updated, jobIds, priority };
  }

  return {
    address,
    updated: 0,
    jobIds: [],
    priority,
    message: await buildBumpFailureMessage(store, address),
  };
}
