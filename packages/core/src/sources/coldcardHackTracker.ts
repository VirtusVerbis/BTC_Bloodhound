import { createHash } from "node:crypto";
import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
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

  const addresses = [...new Set(body.addresses.map((a) => a.address.toLowerCase()))].sort();
  const contentHash = createHash("sha256")
    .update(`${body.updatedAt ?? ""}\n${addresses.join("\n")}`)
    .digest("hex");

  return { addresses, contentHash };
}

export function applyColdcardHackTrackerSync(store: Store, data: ColdcardHackTrackerData): number {
  let inserted = 0;
  for (const address of data.addresses) {
    const added = insertAddressIfMissing(store, address, {
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcard_hack_tracker",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (added) {
      inserted++;
      store.enqueueJob("backfill_hacker_address", { address }, JOB_PRIORITY.BACKFILL_HACKER);
    }
  }

  store.upsertSourceSync("coldcard_hack_tracker", {
    lastAddressCount: data.addresses.length,
    lastContentHash: data.contentHash,
  });

  return inserted;
}
