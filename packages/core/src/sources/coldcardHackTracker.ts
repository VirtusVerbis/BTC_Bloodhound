import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { sha256Hex } from "../util/hash.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { insertAddressIfMissing } from "./insertIfMissing.js";
import { instrumentedFetch, type SubrequestSink } from "../subrequest/instrumentedFetch.js";
import type { JobSubrequestBudget } from "../indexer/subrequestBudget.js";

export interface ColdcardHackTrackerData {
  addresses: string[];
  contentHash: string;
}

export async function fetchColdcardHackTracker(
  base: string,
  sink?: SubrequestSink,
): Promise<ColdcardHackTrackerData> {
  const res = await instrumentedFetch(
    `${base}/snapshot.json`,
    {
      headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "application/json" },
    },
    sink,
  );
  if (!res.ok) throw new Error(`ColdcardHackTracker fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    updatedAt?: string;
    addresses: Array<{ address: string }>;
  };

  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const entry of body.addresses) {
    const normalized = normalizeBitcoinAddress(entry.address);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    addresses.push(normalized);
  }
  addresses.sort();
  const contentHash = await sha256Hex(`${body.updatedAt ?? ""}\n${addresses.join("\n")}`);

  return { addresses, contentHash };
}

export interface ColdcardHackTrackerBatchPayload {
  contentHash: string;
  addresses?: string[];
  finalize?: boolean;
  lastAddressCount?: number;
  chunkIndex?: number;
  chunkTotal?: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function enqueueColdcardHackTrackerBatchJobs(
  store: Store,
  data: ColdcardHackTrackerData,
  perJob: number,
): Promise<void> {
  const chunks = chunkArray(data.addresses, perJob);
  if (chunks.length === 0) {
    await store.upsertSourceSync("coldcard_hack_tracker", {
      lastAddressCount: data.addresses.length,
      lastContentHash: data.contentHash,
    });
    return;
  }
  for (let i = 0; i < chunks.length; i++) {
    const finalize = i === chunks.length - 1;
    await store.enqueueJob(
      "sync_vercel_trackers",
      {
        source: "coldcard_hack_tracker",
        contentHash: data.contentHash,
        addresses: chunks[i],
        finalize,
        lastAddressCount: data.addresses.length,
        chunkIndex: i + 1,
        chunkTotal: chunks.length,
      },
      JOB_PRIORITY.SYNC_VERCEL_TRACKERS,
    );
  }
}

export async function applyColdcardHackTrackerSyncBatch(
  store: Store,
  payload: ColdcardHackTrackerBatchPayload,
  opts?: { jobSubreq?: JobSubrequestBudget },
): Promise<number> {
  let inserted = 0;
  const addresses = payload.addresses ?? [];
  for (let i = 0; i < addresses.length; i++) {
    if (opts?.jobSubreq?.exhausted()) {
      const remaining = addresses.slice(i);
      if (remaining.length > 0) {
        await store.enqueueJob(
          "sync_vercel_trackers",
          {
            source: "coldcard_hack_tracker",
            contentHash: payload.contentHash,
            addresses: remaining,
            finalize: payload.finalize,
            lastAddressCount: payload.lastAddressCount,
            chunkIndex: payload.chunkIndex,
            chunkTotal: payload.chunkTotal,
          },
          JOB_PRIORITY.SYNC_VERCEL_TRACKERS,
        );
      }
      return inserted;
    }
    const address = addresses[i]!;
    const added = await insertAddressIfMissing(store, address, {
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcard_hack_tracker",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (added) {
      inserted++;
      await store.enqueueJobIfAbsent(
        "backfill_hacker_address",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { address },
      );
    }
  }
  if (payload.finalize) {
    await store.upsertSourceSync("coldcard_hack_tracker", {
      lastAddressCount: payload.lastAddressCount ?? payload.addresses?.length ?? 0,
      lastContentHash: payload.contentHash,
    });
  }
  return inserted;
}

export async function applyColdcardHackTrackerSync(store: Store, data: ColdcardHackTrackerData): Promise<number> {
  let inserted = 0;
  for (const address of data.addresses) {
    const added = await insertAddressIfMissing(store, address, {
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcard_hack_tracker",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (added) {
      inserted++;
      await store.enqueueJobIfAbsent(
        "backfill_hacker_address",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { address },
      );
    }
  }

  await store.upsertSourceSync("coldcard_hack_tracker", {
    lastAddressCount: data.addresses.length,
    lastContentHash: data.contentHash,
  });

  return inserted;
}
