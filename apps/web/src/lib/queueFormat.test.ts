import { describe, expect, it } from "vitest";
import {
  formatJobDetailLine,
  formatJobTypeLabel,
  formatRunningElapsed,
  formatSnapshotAge,
  jobClassBorderClass,
} from "./queueFormat";
import type { QueueJob } from "./queueApi";

function sampleJob(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: 1,
    type: "expand_downstream",
    status: "pending",
    priority: 5,
    priorityName: "CRON_EXPAND",
    jobClass: "ingest",
    runAfter: "2026-01-01T00:00:00.000Z",
    runAfterDue: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    attempts: 0,
    lastError: null,
    details: {},
    ...overrides,
  };
}

describe("formatSnapshotAge", () => {
  it("returns just now for sub-second elapsed", () => {
    expect(formatSnapshotAge(500)).toBe("just now");
  });

  it("formats seconds and minutes", () => {
    expect(formatSnapshotAge(45_000)).toBe("45s ago");
    expect(formatSnapshotAge(134_000)).toBe("2m 14s ago");
  });
});

describe("formatJobTypeLabel", () => {
  it("title-cases snake_case job types", () => {
    expect(formatJobTypeLabel("expand_downstream")).toBe("Expand Downstream");
    expect(formatJobTypeLabel("poll_hacker_address")).toBe("Poll Hacker Address");
  });
});

describe("formatJobDetailLine", () => {
  it("formats expand continuation with progress", () => {
    const line = formatJobDetailLine(
      sampleJob({
        details: {
          address: "bc1qabcdefghijklmnopqrstuvwxyz",
          continuation: true,
          pendingTxidsCount: 8,
          processedIndex: 3,
        },
      }),
    );
    expect(line).toContain("bc1qab");
    expect(line).toContain("continuation");
    expect(line).toContain("8 tx pending");
    expect(line).toContain("progress 3/8");
  });

  it("formats poll job address", () => {
    const line = formatJobDetailLine(
      sampleJob({
        type: "poll_downstream_address",
        details: { address: "bc1qtestaddress1234567890abcdefghij" },
      }),
    );
    expect(line).toContain("bc1qte");
  });

  it("formats process_tx txid", () => {
    const line = formatJobDetailLine(
      sampleJob({
        type: "process_tx",
        details: { txid: "a3f2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3" },
      }),
    );
    expect(line).toContain("a3f2b1c0");
  });

  it("returns sync labels for empty payloads", () => {
    expect(formatJobDetailLine(sampleJob({ type: "sync_coldcardwatch", details: {} }))).toBe(
      "External sync",
    );
  });
});

describe("jobClassBorderClass", () => {
  it("maps job classes to css modifiers", () => {
    expect(jobClassBorderClass("ingest")).toBe("queue-job-card--ingest");
    expect(jobClassBorderClass("maint")).toBe("queue-job-card--maint");
    expect(jobClassBorderClass("cosmetic")).toBe("queue-job-card--cosmetic");
  });
});

describe("formatRunningElapsed", () => {
  it("formats elapsed from startedAt", () => {
    const now = new Date("2026-01-01T00:01:30.000Z").getTime();
    expect(formatRunningElapsed("2026-01-01T00:00:00.000Z", now)).toBe("1m 30s");
  });
});
