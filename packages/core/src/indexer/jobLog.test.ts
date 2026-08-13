import { describe, expect, it, vi } from "vitest";
import type { Job } from "@cointrace/db";
import { formatJobStartLine, logCronDetail, logJobFail } from "./jobLog.js";

function makeJob(overrides: Partial<Job> & Pick<Job, "type" | "payloadJson">): Job {
  return {
    id: 42,
    status: "running",
    priority: 10,
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe("jobLog", () => {
  it("formatJobStartLine includes type and address for backfill_hacker_address", () => {
    const line = formatJobStartLine(
      makeJob({
        type: "backfill_hacker_address",
        payloadJson: JSON.stringify({
          address: "bc1qtest",
          pendingTxids: ["tx1"],
          chainCursor: "cursor",
        }),
      }),
    );
    expect(line).toContain("id=42");
    expect(line).toContain("type=backfill_hacker_address");
    expect(line).toContain("address=bc1qtest");
    expect(line).toContain("continuation=true");
    expect(line).toContain("pendingTxidsCount=1");
  });

  it("logCronDetail does not log when disabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logCronDetail(false, "[cron] tick start");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logCronDetail logs when enabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logCronDetail(true, "[cron] tick start");
    expect(spy).toHaveBeenCalledWith("[cron] tick start");
    spy.mockRestore();
  });

  it("logJobFail always logs error details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = makeJob({
      type: "poll_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
    });
    logJobFail(job, new Error("429 Too Many Requests"));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[job] fail id=42 type=poll_hacker_address address=bc1qhack"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("error=429 Too Many Requests"));
    spy.mockRestore();
  });
});
