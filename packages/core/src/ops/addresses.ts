import type { Store } from "@cointrace/db";
import { normalizeBitcoinAddress } from "../util/address.js";

export interface InvalidAddressRow {
  address: string;
  role: string;
  isFlaggedHacker: boolean;
}

export interface PruneInvalidAddressesResult {
  scanned: number;
  invalid: number;
  dryRun: boolean;
  invalidAddresses: InvalidAddressRow[];
  removed?: number;
  hackersUnflagged?: number;
  rowsDeleted?: number;
  jobsCancelled?: number;
  edgesRemoved?: number;
}

function mapInvalidRows(
  rows: Array<{ address: string; role: string; isFlaggedHacker: boolean }>,
): InvalidAddressRow[] {
  return rows.map((row) => ({
    address: row.address,
    role: row.role,
    isFlaggedHacker: row.isFlaggedHacker,
  }));
}

export async function pruneInvalidAddresses(
  store: Store,
  opts: { dryRun?: boolean } = {},
): Promise<PruneInvalidAddressesResult> {
  const dryRun = opts.dryRun === true;
  const all = await store.listAllAddresses();
  const invalidRows = all.filter((row) => normalizeBitcoinAddress(row.address) === null);

  if (dryRun) {
    return {
      scanned: all.length,
      invalid: invalidRows.length,
      dryRun: true,
      invalidAddresses: mapInvalidRows(invalidRows),
    };
  }

  let jobsCancelled = 0;
  let edgesRemoved = 0;
  let rowsDeleted = 0;
  let hackersUnflagged = 0;

  for (const row of invalidRows) {
    if (row.isFlaggedHacker) hackersUnflagged++;
    jobsCancelled += await store.deleteActiveJobsForAddress(row.address);
    edgesRemoved += await store.deleteEdgesTouchingAddress(row.address);
    await store.deleteAddress(row.address);
    rowsDeleted++;
  }

  return {
    scanned: all.length,
    invalid: invalidRows.length,
    dryRun: false,
    invalidAddresses: mapInvalidRows(invalidRows),
    removed: rowsDeleted,
    hackersUnflagged,
    rowsDeleted,
    jobsCancelled,
    edgesRemoved,
  };
}
