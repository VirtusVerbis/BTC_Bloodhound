import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";

export type SourceDeltaRow = { isFlaggedHacker: boolean };

export function partitionSourceHackers(
  addresses: string[],
  existing: Map<string, SourceDeltaRow>,
): { ingest: string[]; knownFlagged: string[] } {
  const ingest: string[] = [];
  const knownFlagged: string[] = [];
  for (const address of addresses) {
    const row = existing.get(address);
    if (row?.isFlaggedHacker) knownFlagged.push(address);
    else ingest.push(address);
  }
  return { ingest, knownFlagged };
}

export function partitionSourceMissing(
  addresses: string[],
  existing: Map<string, unknown>,
): { missing: string[]; known: string[] } {
  const missing: string[] = [];
  const known: string[] = [];
  for (const address of addresses) {
    if (existing.has(address)) known.push(address);
    else missing.push(address);
  }
  return { missing, known };
}

export function sourceDeltaEmpty(parts: {
  hackers?: string[];
  victims?: string[];
  downstream?: string[];
}): boolean {
  return (
    (parts.hackers?.length ?? 0) === 0 &&
    (parts.victims?.length ?? 0) === 0 &&
    (parts.downstream?.length ?? 0) === 0
  );
}

/** Insert or promote a source collector as a flagged hacker and enqueue backfill. Skips already-flagged rows. */
export async function ingestSourceHacker(
  store: Store,
  address: string,
  source: string,
): Promise<boolean> {
  const inserted = await store.insertAddressIfMissing({
    address,
    role: "hacker",
    isFlaggedHacker: true,
    source,
    hopFromHacker: 0,
    expandStatus: "pending",
  });
  if (!inserted) {
    const existing = await store.getAddress(address);
    if (existing?.isFlaggedHacker) return false;
    await store.upsertAddress({
      address,
      role: "hacker",
      isFlaggedHacker: true,
      source,
      hopFromHacker: 0,
    });
  }
  await store.enqueueJobIfAbsent(
    "backfill_hacker_address",
    { address },
    JOB_PRIORITY.BACKFILL_HACKER,
    undefined,
    { address },
  );
  return true;
}
