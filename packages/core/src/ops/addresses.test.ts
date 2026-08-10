import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { invalidVectorByLabel, validVectorByLabel } from "../util/addressVectors.js";
import { pruneInvalidAddresses } from "./addresses.js";

const VALID_HACKER = validVectorByLabel("P2WPKH bc1q").expected;
const VALID_DOWNSTREAM = validVectorByLabel("P2TR bc1p prod downstream").expected;
const INVALID_HACKER = invalidVectorByLabel("prod junk legacy 1").input;
const INVALID_VICTIM = invalidVectorByLabel("prod junk legacy 3").input;

async function freshStore() {
  const { sqlite, db } = openDatabase(":memory:");
  runMigrations(sqlite);
  return new Store(db);
}

describe("pruneInvalidAddresses", () => {
  it("dry-run finds invalid rows across roles without deleting valid bc1p downstream", async () => {
    const store = await freshStore();
    await store.upsertAddress({
      address: VALID_HACKER,
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    await store.upsertAddress({
      address: VALID_DOWNSTREAM,
      role: "downstream",
      hopFromHacker: 1,
    });
    await store.upsertAddress({
      address: INVALID_HACKER,
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    await store.upsertAddress({ address: INVALID_VICTIM, role: "victim" });
    await store.enqueueJob("backfill_hacker_address", { address: INVALID_HACKER }, JOB_PRIORITY.BACKFILL_HACKER);

    const result = await pruneInvalidAddresses(store, { dryRun: true });

    expect(result.scanned).toBe(4);
    expect(result.invalid).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(result.invalidAddresses).toHaveLength(2);
    expect(result.invalidAddresses.map((r) => r.address).sort()).toEqual(
      [INVALID_HACKER, INVALID_VICTIM].sort(),
    );
    expect(result.removed).toBeUndefined();
    expect(await store.getAddress(VALID_DOWNSTREAM)).toBeTruthy();
    expect(await store.getAddress(INVALID_HACKER)).toBeTruthy();
    expect(await store.hasPendingJob("backfill_hacker_address", INVALID_HACKER)).toBe(true);
  });

  it("execute removes invalid rows, cancels jobs, and keeps valid addresses", async () => {
    const store = await freshStore();
    await store.upsertAddress({
      address: VALID_HACKER,
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    await store.upsertAddress({
      address: VALID_DOWNSTREAM,
      role: "downstream",
      hopFromHacker: 1,
    });
    await store.upsertAddress({
      address: INVALID_HACKER,
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    await store.upsertAddress({ address: INVALID_VICTIM, role: "victim" });
    await store.enqueueJob("backfill_hacker_address", { address: INVALID_HACKER }, JOB_PRIORITY.BACKFILL_HACKER);
    await store.enqueueJob("poll_hacker_address", { address: VALID_HACKER }, JOB_PRIORITY.POLL_HACKER);

    const result = await pruneInvalidAddresses(store);

    expect(result.dryRun).toBe(false);
    expect(result.invalid).toBe(2);
    expect(result.removed).toBe(2);
    expect(result.rowsDeleted).toBe(2);
    expect(result.hackersUnflagged).toBe(1);
    expect(result.jobsCancelled).toBeGreaterThanOrEqual(1);
    expect(await store.getAddress(INVALID_HACKER)).toBeUndefined();
    expect(await store.getAddress(INVALID_VICTIM)).toBeUndefined();
    expect(await store.getAddress(VALID_HACKER)).toBeTruthy();
    expect(await store.getAddress(VALID_DOWNSTREAM)).toBeTruthy();
    expect(await store.hasPendingJob("poll_hacker_address", VALID_HACKER)).toBe(true);
  });
});
