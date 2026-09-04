import { describe, expect, it } from "vitest";
import type { Job } from "@cointrace/db";
import { JOB_PRIORITY, loadConfig } from "../config.js";
import {
  ageBoostForJob,
  effectiveJobPriority,
  jobRunnableAtMs,
  jobWaitMs,
  toClaimAgeBoost,
} from "./jobAge.js";

const config = loadConfig();

function makeJob(overrides: Partial<Job> & Pick<Job, "type" | "priority">): Job {
  const now = new Date().toISOString();
  return {
    id: 1,
    status: "pending",
    payloadJson: "{}",
    runAfter: now,
    attempts: 0,
    lastError: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    reclaimCount: 0,
    reclaimProgressJson: null,
    ...overrides,
  };
}

describe("jobAge", () => {
  it("computes runnableAt as max(createdAt, runAfter)", () => {
    const job = makeJob({
      type: "sync_coldcardwatch",
      priority: JOB_PRIORITY.SYNC_COLDCARDWATCH,
      createdAt: "2026-01-01T00:00:00.000Z",
      runAfter: "2026-01-02T00:00:00.000Z",
    });
    expect(jobRunnableAtMs(job)).toBe(new Date("2026-01-02T00:00:00.000Z").getTime());
  });

  it("does not boost ingest job types", () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const job = makeJob({
      type: "expand_downstream",
      priority: JOB_PRIORITY.CRON_EXPAND,
      createdAt: old,
      runAfter: old,
    });
    expect(ageBoostForJob(job, config)).toBe(0);
    expect(effectiveJobPriority(job, config)).toBe(JOB_PRIORITY.CRON_EXPAND);
  });

  it("boosts maint jobs after interval and caps at max", () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const job = makeJob({
      type: "sync_coldcardwatch",
      priority: JOB_PRIORITY.SYNC_COLDCARDWATCH,
      createdAt: old,
      runAfter: old,
    });
    const boost = ageBoostForJob(job, config);
    expect(boost).toBeGreaterThanOrEqual(3);
    expect(boost).toBeLessThanOrEqual(config.ageBoostMax);
    expect(effectiveJobPriority(job, config)).toBe(job.priority + boost);
  });

  it("uses defer run_after when later than created_at", () => {
    const created = new Date(Date.now() - 10_000).toISOString();
    const runAfter = new Date(Date.now() + 3_600_000).toISOString();
    const job = makeJob({
      type: "sync_coldcardwatch",
      priority: JOB_PRIORITY.SYNC_COLDCARDWATCH,
      createdAt: created,
      runAfter: runAfter,
    });
    const nowMs = Date.now();
    expect(jobWaitMs(job, nowMs)).toBe(0);
    expect(ageBoostForJob(job, config, nowMs)).toBe(0);
  });

  it("maps config to ClaimAgeBoost", () => {
    const mapped = toClaimAgeBoost(config);
    expect(mapped.enabled).toBe(config.ageBoostEnabled);
    expect(mapped.intervalSec).toBe(config.ageBoostIntervalSec);
    expect(mapped.maxBoost).toBe(config.ageBoostMax);
    expect(mapped.eligibleTypes).toContain("sync_coldcardwatch");
    expect(mapped.eligibleTypes).not.toContain("expand_downstream");
  });
});
