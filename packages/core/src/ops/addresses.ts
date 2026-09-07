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

export interface RepairVictimRolesResult {
  dryRun: boolean;
  scanned: number;
  polluted: string[];
  repaired: string[];
  jobsCancelled: number;
}

export async function repairVictimRoles(
  store: Store,
  opts: { address?: string; dryRun?: boolean } = {},
): Promise<RepairVictimRolesResult> {
  const dryRun = opts.dryRun === true;
  const polluted = await store.listVictimRolePollution({ address: opts.address });
  if (dryRun) {
    return {
      dryRun: true,
      scanned: polluted.length,
      polluted,
      repaired: [],
      jobsCancelled: 0,
    };
  }

  const result = await store.repairVictimRolePollution({ address: opts.address, dryRun: false });
  return {
    dryRun: false,
    scanned: result.scanned,
    polluted,
    repaired: result.repaired,
    jobsCancelled: result.jobsCancelled,
  };
}
