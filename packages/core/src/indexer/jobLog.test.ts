import { describe, expect, it, vi } from "vitest";
import type { Job } from "@cointrace/db";
import { RateLimitNotReadyError } from "../chain/router.js";
import { formatJobDoneLine, formatJobStartLine, logCronDetail, logJobDefer, logJobFail } from "./jobLog.js";

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
  it("formatJobStartLine includes claim meta when provided", () => {
    const line = formatJobStartLine(
      makeJob({
        type: "backfill_hacker_address",
        payloadJson: JSON.stringify({
          address: "bc1qtest",
          pendingTxids: ["tx1"],
        }),
      }),
      { slot: 1, weight: "light", phase: "process" },
    );
    expect(line).toContain("slot=1");
    expect(line).toContain("weight=light");
    expect(line).toContain("phase=process");
  });

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
    expect(line).toContain("attempts=0");
    expect(line).toContain("address=bc1qtest");
    expect(line).toContain("continuation=true");
    expect(line).toContain("pendingTxidsCount=1");
    expect(line).toContain("processedIndex=");
    expect(line).toContain("chainCursor=cursor");
  });

  it("formatJobStartLine includes progress and pagesFetched when present", () => {
    const line = formatJobStartLine(
      makeJob({
        type: "expand_downstream",
        payloadJson: JSON.stringify({
          address: "bc1qtest",
          pendingTxids: Array.from({ length: 25 }, (_, i) => `tx${i}`),
          processedIndex: 18,
          pagesExhausted: false,
          pagesFetched: 3,
        }),
      }),
    );
    expect(line).toContain("pendingTxidsCount=25");
    expect(line).toContain("processedIndex=18");
    expect(line).toContain("progress=18/25");
    expect(line).toContain("pagesFetched=3");
  });

  it("formatJobDoneLine includes progress suffix for ingest jobs", () => {
    const line = formatJobDoneLine(
      makeJob({
        type: "expand_downstream",
        payloadJson: JSON.stringify({
          address: "bc1qtest",
          pendingTxids: Array.from({ length: 25 }, (_, i) => `tx${i}`),
          processedIndex: 19,
        }),
      }),
      "3.5s",
      310,
      { continued: true },
    );
    expect(line).toContain("continued=true");
    expect(line).toContain("progress=19/25");
    expect(line).toContain("processedIndex=19");
  });

  it("formatJobDoneLine omits progress for non-ingest jobs", () => {
    const line = formatJobDoneLine(
      makeJob({
        type: "refresh_live_balance",
        payloadJson: JSON.stringify({ address: "bc1qtest" }),
      }),
      "1.2s",
      42,
    );
    expect(line).not.toContain("progress=");
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
    logJobFail(job, new Error("429 Too Many Requests"), { attempt: 3 });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[job] fail id=42 type=poll_hacker_address attempts=3 address=bc1qhack"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("error=429 Too Many Requests"));
    spy.mockRestore();
  });

  it("logJobFail includes reason for RateLimitNotReadyError", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = makeJob({
      type: "backfill_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qtest" }),
    });
    const retryAt = "2026-08-13T05:51:05.846Z";
    logJobFail(job, new RateLimitNotReadyError(retryAt, "pacing"), { attempt: 3 });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("reason=pacing error=Provider pacing: next call allowed at 2026-08-13T05:51:05.846Z"),
    );
    spy.mockRestore();
  });

  it("logJobFail emits ANSI color when enabled", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = makeJob({
      type: "poll_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
    });
    logJobFail(job, new Error("429 Too Many Requests"), { attempt: 3, color: true });
    const logged = String(spy.mock.calls[0]?.[0]);
    expect(logged).toContain("\x1b[");
    expect(logged).toContain("429 Too Many Requests");
    expect(logged).toMatch(/\x1b\[31merror=\x1b\[0m429 Too Many Requests/);
    spy.mockRestore();
  });

  it("logJobDefer logs defer details", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = makeJob({
      type: "backfill_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qtest" }),
    });
    logJobDefer(job, { attempt: 20, deferSec: 86400, runAfter: "2026-08-13T00:00:00.000Z" });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[job] defer id=42 type=backfill_hacker_address attempts=20 deferSec=86400 run_after=2026-08-13T00:00:00.000Z"),
    );
    spy.mockRestore();
  });
});
