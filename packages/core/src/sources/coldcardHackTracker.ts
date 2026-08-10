import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { sha256Hex } from "../util/hash.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { insertAddressIfMissing } from "./insertIfMissing.js";

export interface ColdcardHackTrackerData {
  addresses: string[];
  contentHash: string;
}

export async function fetchColdcardHackTracker(base: string): Promise<ColdcardHackTrackerData> {
  const res = await fetch(`${base}/snapshot.json`, {
    headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "application/json" },
  });
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
      await store.enqueueJob("backfill_hacker_address", { address }, JOB_PRIORITY.BACKFILL_HACKER);
    }
  }

  await store.upsertSourceSync("coldcard_hack_tracker", {
    lastAddressCount: data.addresses.length,
    lastContentHash: data.contentHash,
  });

  return inserted;
}
