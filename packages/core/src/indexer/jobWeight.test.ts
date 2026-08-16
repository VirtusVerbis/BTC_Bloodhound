import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import {
  jobNeedsChainCallAtStart,
  jobWeightTier,
  jobWorkPhase,
  pickIngestCandidate,
} from "./jobWeight.js";
import type { Job } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";

function baseConfig(): Partial<AppConfig> {
  return {
    backfillTxsPerJob: 1,
    backfillMaxTxs: 10000,
    maxSubrequestsPerJob: 6,
    subrequestLimitPerInvocation: 50,
    scheduleSubrequestReserve: 15,
  };
}

function makeJob(
  id: number,
  type: string,
  payload: Record<string, unknown>,
): Job {
  return {
    id,
    type,
    status: "pending",
    priority: JOB_PRIORITY.BACKFILL_HACKER,
    payloadJson: JSON.stringify(payload),
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    reclaimCount: 0,
    reclaimProgressJson: null,
  };
}

describe("jobNeedsChainCallAtStart", () => {
  it("returns false when buffered pending txs remain", () => {
    expect(
      jobNeedsChainCallAtStart(
        "backfill_hacker_address",
        {
          address: "bc1q",
          pendingTxids: ["tx1", "tx2"],
          processedIndex: 0,
        },
        baseConfig() as AppConfig,
      ),
    ).toBe(false);
  });

  it("returns true for fresh backfill with no pending", () => {
    expect(
      jobNeedsChainCallAtStart("backfill_hacker_address", { address: "bc1q" }, baseConfig() as AppConfig),
    ).toBe(true);
  });

  it("returns true for poll jobs", () => {
    expect(
      jobNeedsChainCallAtStart("poll_hacker_address", { address: "bc1q" }, baseConfig() as AppConfig),
    ).toBe(true);
  });
});

describe("jobWeightTier", () => {
  it("marks process-only backfill as light", () => {
    expect(
      jobWeightTier(
        "backfill_hacker_address",
        { address: "bc1q", pendingTxids: ["tx1"], processedIndex: 0 },
        baseConfig() as AppConfig,
      ),
    ).toBe("light");
  });

  it("marks fresh fetch backfill as heavy", () => {
    expect(
      jobWeightTier("backfill_hacker_address", { address: "bc1q" }, baseConfig() as AppConfig),
    ).toBe("heavy");
  });

  it("marks trace pending as heavy", () => {
    expect(
      jobWeightTier(
        "expand_downstream",
        { address: "bc1q", traceEdgesPending: true, pendingTxids: ["tx1"], processedIndex: 1 },
        baseConfig() as AppConfig,
      ),
    ).toBe("heavy");
  });
});

describe("jobWorkPhase", () => {
  it("returns process for buffered pending work", () => {
    expect(
      jobWorkPhase(
        "backfill_hacker_address",
        { pendingTxids: ["tx1"], processedIndex: 0 },
        baseConfig() as AppConfig,
      ),
    ).toBe("process");
  });

  it("returns fetch for fresh backfill", () => {
    expect(jobWorkPhase("backfill_hacker_address", { address: "bc1q" }, baseConfig() as AppConfig)).toBe(
      "fetch",
    );
  });

  it("returns poll for poll jobs", () => {
    expect(jobWorkPhase("poll_hacker_address", { address: "bc1q" }, baseConfig() as AppConfig)).toBe("poll");
  });
});

describe("pickIngestCandidate", () => {
  it("filters to process-only when requireNoChainAtStart", () => {
    const heavy = makeJob(1, "backfill_hacker_address", { address: "bc1q" });
    const light = makeJob(2, "backfill_hacker_address", {
      address: "bc1q2",
      pendingTxids: ["tx1"],
      processedIndex: 0,
    });
    const pick = pickIngestCandidate([heavy, light], baseConfig() as AppConfig, {
      requireNoChainAtStart: true,
    });
    expect(pick?.id).toBe(2);
  });
});
