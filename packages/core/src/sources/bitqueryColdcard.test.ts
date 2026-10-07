import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import type { Store as StoreType } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { loadConfig } from "../config.js";
import { processJobs } from "../indexer/processor.js";
import type { JobSubrequestBudget } from "../indexer/subrequestBudget.js";
import {
  applyBitqueryColdcardSyncBatch,
  bitqueryColdcardContentHash,
  enqueueBitqueryColdcardBatchJobs,
  fetchBitqueryColdcard,
  parseBitqueryColdcardCsv,
} from "./bitqueryColdcard.js";

const CONFIRMED = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const REPORTED = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ATTRIBUTED = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function csv(balance = "1.0") {
  return [
    "# block 1",
    "address,tier,classification,balance_btc",
    `${CONFIRMED},Confirmed,attacker-controlled (Confirmed),${balance}`,
    `${REPORTED},Reported,"attacker-controlled (Reported)",2.5`,
    `${ATTRIBUTED},Attributed,NOT attacker-controlled (Attributed),0`,
    `bc1qnotreal,Traced,attacker-controlled (Traced),0.1`,
    `venueaddr,Venue,do not treat as attacker-controlled,0`,
  ].join("\n");
}

function freshStore() {
  const { sqlite, db } = openDatabase(":memory:");
  runMigrations(sqlite);
  return new Store(db);
}

describe("parseBitqueryColdcardCsv", () => {
  it("keeps attacker-controlled rows and drops NOT attacker-controlled", () => {
    const addresses = parseBitqueryColdcardCsv(csv());
    expect(addresses).toEqual([CONFIRMED, REPORTED].sort());
    expect(addresses).not.toContain(ATTRIBUTED);
  });

  it("hashes the attacker address list and ignores balances", async () => {
    const a = parseBitqueryColdcardCsv(csv("1.0"));
    const b = parseBitqueryColdcardCsv(csv("9.9"));
    expect(a).toEqual(b);
    expect(await bitqueryColdcardContentHash(a)).toBe(await bitqueryColdcardContentHash(b));
  });

  it("throws when address or classification columns are missing", () => {
    expect(() => parseBitqueryColdcardCsv("address,balance_btc\nbc1q,1")).toThrow(/classification/);
    expect(() => parseBitqueryColdcardCsv("")).toThrow(/classification/);
  });

  it("treats a valid file with zero attacker rows as an empty address list", () => {
    const text = `address,classification\n${ATTRIBUTED},NOT attacker-controlled (Attributed)`;
    expect(parseBitqueryColdcardCsv(text)).toEqual([]);
  });
});

describe("enqueueBitqueryColdcardBatchJobs", () => {
  it("enqueues chunks with finalize only on the last chunk and the full address count", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(1);
    const store = { enqueueJob, upsertSourceSync: vi.fn() } as unknown as StoreType;
    const addresses = Array.from({ length: 12 }, (_, i) => `bc1qaddr${String(i).padStart(2, "0")}`);
    await enqueueBitqueryColdcardBatchJobs(store, { addresses, contentHash: "hash123" }, 5, 118);

    expect(enqueueJob).toHaveBeenCalledTimes(3);
    expect(enqueueJob.mock.calls[0]![0]).toBe("sync_bitquery_coldcard");
    expect(enqueueJob.mock.calls[0]![1]).toMatchObject({
      contentHash: "hash123",
      chunkIndex: 1,
      chunkTotal: 3,
      finalize: false,
      lastAddressCount: 118,
    });
    expect(enqueueJob.mock.calls[2]![1]).toMatchObject({
      chunkIndex: 3,
      chunkTotal: 3,
      finalize: true,
      lastAddressCount: 118,
    });
    expect(store.upsertSourceSync).not.toHaveBeenCalled();
  });
});

describe("applyBitqueryColdcardSyncBatch", () => {
  it("requeues the remainder when the subrequest budget is exhausted", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(2);
    const upsertSourceSync = vi.fn();
    const store = { enqueueJob, upsertSourceSync } as unknown as StoreType;
    const jobSubreq = { exhausted: () => true } as JobSubrequestBudget;
    const inserted = await applyBitqueryColdcardSyncBatch(
      store,
      {
        contentHash: "hash123",
        addresses: ["bc1qa", "bc1qb"],
        finalize: true,
        lastAddressCount: 40,
        chunkIndex: 2,
        chunkTotal: 4,
      },
      { jobSubreq },
    );
    expect(inserted).toBe(0);
    expect(enqueueJob).toHaveBeenCalledWith(
      "sync_bitquery_coldcard",
      {
        contentHash: "hash123",
        addresses: ["bc1qa", "bc1qb"],
        finalize: true,
        lastAddressCount: 40,
        chunkIndex: 2,
        chunkTotal: 4,
      },
      3,
    );
    expect(upsertSourceSync).not.toHaveBeenCalled();
  });

  it("inserts a missing address and skips an existing downstream row", async () => {
    const store = freshStore();
    await store.insertAddressIfMissing({
      address: "bc1qdown",
      role: "downstream",
      expandStatus: "expanded",
    });
    const inserted = await applyBitqueryColdcardSyncBatch(store, {
      contentHash: "hash123",
      addresses: ["bc1qdown", "bc1qnew"],
      finalize: true,
      lastAddressCount: 2,
      chunkIndex: 1,
      chunkTotal: 1,
    });
    expect(inserted).toBe(1);
    const downstream = await store.getAddress("bc1qdown");
    expect(downstream?.role).toBe("downstream");
    expect(downstream?.isFlaggedHacker).toBe(false);
    const created = await store.getAddress("bc1qnew");
    expect(created?.isFlaggedHacker).toBe(true);
    expect(created?.role).toBe("hacker");
    expect(created?.hopFromHacker).toBe(0);
    expect(created?.expandStatus).toBe("pending");
    expect(await store.hasPendingJob("backfill_hacker_address", "bc1qnew")).toBe(true);
    expect(await store.hasPendingJob("backfill_hacker_address", "bc1qdown")).toBe(false);
    const sync = await store.getSourceSync("bitquery_coldcard");
    expect(sync?.lastContentHash).toBe("hash123");
    expect(sync?.lastAddressCount).toBe(2);
    expect(sync?.lastError).toBeNull();
  });
});

describe("bitquery and vercel poll errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records last_error on a thrown fetch without moving last_sync_at, and a later sync clears it", async () => {
    const store = freshStore();
    await store.upsertSourceSync("bitquery_coldcard", { lastAddressCount: 4, lastContentHash: "old" });
    const before = await store.getSourceSync("bitquery_coldcard");
    await store.enqueueJob("sync_bitquery_coldcard", {}, 3);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const config = loadConfig({});
    await processJobs(store, {} as ChainRouter, { ...config, jobsPerTick: 1 });
    const failed = await store.getSourceSync("bitquery_coldcard");
    expect(failed?.lastError).toMatch(/500/);
    expect(failed?.lastSyncAt).toBe(before?.lastSyncAt);
    expect(failed?.lastContentHash).toBe("old");

    await store.upsertSourceSync("bitquery_coldcard", { lastContentHash: "old" });
    const cleared = await store.getSourceSync("bitquery_coldcard");
    expect(cleared?.lastError).toBeNull();
    expect(cleared?.lastSyncAt).not.toBe(before?.lastSyncAt);
  });

  it("clears last_error when a later fetch sync succeeds", async () => {
    const store = freshStore();
    await store.setSourceSyncError("bitquery_coldcard", "Bitquery Coldcard CSV fetch failed: 500");
    expect((await store.getSourceSync("bitquery_coldcard"))?.lastSyncAt).toBeNull();
    await store.enqueueJob("sync_bitquery_coldcard", {}, 3);
    const empty = `address,classification\n${ATTRIBUTED},NOT attacker-controlled (Attributed)`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(empty, { status: 200, headers: { "Content-Type": "text/csv" } })),
    );
    await processJobs(store, {} as ChainRouter, { ...loadConfig({}), jobsPerTick: 1 });
    const synced = await store.getSourceSync("bitquery_coldcard");
    expect(synced?.lastError).toBeNull();
    expect(synced?.lastSyncAt).not.toBeNull();
    expect(synced?.lastAddressCount).toBe(0);
  });

  it("marks only coldcard_sweep_watch when that fetch fails", async () => {
    const store = freshStore();
    await store.upsertSourceSync("coldcard_hack_tracker", { lastAddressCount: 1, lastContentHash: "hack" });
    await store.upsertSourceSync("coldcard_sweep_watch", { lastAddressCount: 1, lastContentHash: "sweep" });
    const hackBefore = await store.getSourceSync("coldcard_hack_tracker");
    const sweepBefore = await store.getSourceSync("coldcard_sweep_watch");
    await store.enqueueJob("sync_vercel_trackers", {}, 3);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("snapshot.json")) {
          return new Response(JSON.stringify({ addresses: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("down", { status: 500 });
      }),
    );
    await processJobs(store, {} as ChainRouter, { ...loadConfig({}), jobsPerTick: 1 });
    const hack = await store.getSourceSync("coldcard_hack_tracker");
    const sweep = await store.getSourceSync("coldcard_sweep_watch");
    expect(hack?.lastError).toBeNull();
    expect(hack?.lastSyncAt).toBe(hackBefore?.lastSyncAt);
    expect(sweep?.lastError).toMatch(/500/);
    expect(sweep?.lastSyncAt).toBe(sweepBefore?.lastSyncAt);
    const pending = await store.listActiveJobs({ statuses: ["pending"] });
    expect(pending.some((job) => job.payloadJson.includes("addresses"))).toBe(false);
  });
});

describe("fetchBitqueryColdcard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(fetchBitqueryColdcard("https://bitquery.io/coldcard.csv")).rejects.toThrow(/404/);
  });
});
