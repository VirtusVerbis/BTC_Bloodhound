import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import type { Job } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { effectiveJobsPerTick, planTickJobs, shouldDrainBeforeSchedule } from "./tickPolicy.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    jobsPerTick: 1,
    jobsPerTickMax: 3,
    queueDepthPerExtraJob: 40,
    queueDrainFirstDepth: 1,
    queueSoftThrottleDepth: 80,
    ...overrides,
  } as AppConfig;
}

describe("shouldDrainBeforeSchedule", () => {
  it("returns true when continuation is pending", () => {
    expect(
      shouldDrainBeforeSchedule({
        continuationPending: true,
        queueDepth: 0,
        queueDrainFirstDepth: 1,
      }),
    ).toBe(true);
  });

  it("returns true when queue depth meets drain threshold", () => {
    expect(
      shouldDrainBeforeSchedule({
        continuationPending: false,
        queueDepth: 5,
        queueDrainFirstDepth: 1,
      }),
    ).toBe(true);
  });

  it("returns false when queue is empty and no continuation", () => {
    expect(
      shouldDrainBeforeSchedule({
        continuationPending: false,
        queueDepth: 0,
        queueDrainFirstDepth: 1,
      }),
    ).toBe(false);
  });
});

describe("effectiveJobsPerTick", () => {
  it("returns base jobsPerTick at depth 0", () => {
    expect(effectiveJobsPerTick(baseConfig(), 0)).toBe(1);
  });

  it("adds one job per queueDepthPerExtraJob step", () => {
    const config = baseConfig({ jobsPerTick: 1, jobsPerTickMax: 3, queueDepthPerExtraJob: 40 });
    expect(effectiveJobsPerTick(config, 40)).toBe(1);
    expect(effectiveJobsPerTick(config, 41)).toBe(2);
    expect(effectiveJobsPerTick(config, 81)).toBe(3);
  });

  it("never exceeds jobsPerTickMax", () => {
    const config = baseConfig({ jobsPerTick: 1, jobsPerTickMax: 2, queueDepthPerExtraJob: 10 });
    expect(effectiveJobsPerTick(config, 500)).toBe(2);
  });
});

function makeIngestJob(id: number, payload: Record<string, unknown>): Job {
  return {
    id,
    type: "backfill_hacker_address",
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

describe("planTickJobs", () => {
  const config = baseConfig({
    jobsPerTick: 2,
    jobsPerTickMax: 2,
    queueDepthPerExtraJob: 50,
    backfillTxsPerJob: 1,
    subrequestLimitPerInvocation: 50,
    scheduleSubrequestReserve: 15,
    maxSubrequestsPerJob: 6,
  }) as AppConfig;

  it("caps at 1 when head is heavy", () => {
    const candidates = [
      makeIngestJob(1, { address: "bc1qheavy", chainCursor: "abc" }),
    ];
    const plan = planTickJobs(config, 100, candidates);
    expect(plan.jobsCap).toBe(1);
    expect(plan.reason).toBe("heavy_head");
    expect(plan.headWeight).toBe("heavy");
  });

  it("allows pair when two process-only light jobs exist", () => {
    const candidates = [
      makeIngestJob(1, { address: "bc1qa", pendingTxids: ["tx1"], processedIndex: 0 }),
      makeIngestJob(2, { address: "bc1qb", pendingTxids: ["tx2"], processedIndex: 0 }),
    ];
    const plan = planTickJobs(config, 100, candidates);
    expect(plan.jobsCap).toBe(2);
    expect(plan.reason).toBe("pair_light");
    expect(plan.pairableCount).toBe(2);
  });
});
