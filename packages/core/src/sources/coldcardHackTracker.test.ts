import { describe, expect, it, vi } from "vitest";
import type { Store } from "@cointrace/db";
import { enqueueColdcardHackTrackerBatchJobs } from "./coldcardHackTracker.js";

describe("enqueueColdcardHackTrackerBatchJobs", () => {
  it("enqueues chunk jobs with chunkIndex and chunkTotal", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(1);
    const store = {
      enqueueJob,
      upsertSourceSync: vi.fn(),
    } as unknown as Store;

    const addresses = Array.from({ length: 12 }, (_, i) => `bc1qaddr${String(i).padStart(2, "0")}`);
    await enqueueColdcardHackTrackerBatchJobs(
      store,
      { addresses, contentHash: "hash123" },
      5,
    );

    expect(enqueueJob).toHaveBeenCalledTimes(3);
    expect(enqueueJob.mock.calls[0]![1]).toMatchObject({
      chunkIndex: 1,
      chunkTotal: 3,
      finalize: false,
    });
    expect(enqueueJob.mock.calls[1]![1]).toMatchObject({
      chunkIndex: 2,
      chunkTotal: 3,
      finalize: false,
    });
    expect(enqueueJob.mock.calls[2]![1]).toMatchObject({
      chunkIndex: 3,
      chunkTotal: 3,
      finalize: true,
    });
  });
});
