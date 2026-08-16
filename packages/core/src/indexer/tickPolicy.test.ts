import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { effectiveJobsPerTick, shouldDrainBeforeSchedule } from "./tickPolicy.js";

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
