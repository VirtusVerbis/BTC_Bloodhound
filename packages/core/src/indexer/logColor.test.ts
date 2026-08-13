import { describe, expect, it } from "vitest";
import { colorizeIndexerLogLine } from "./logColor.js";

describe("colorizeIndexerLogLine", () => {
  const sampleFail =
    "[job] fail id=42 type=backfill_hacker_address address=bc1qtest continuation=true reason=pacing error=Provider pacing: next call allowed at 2026-08-13T05:51:05.846Z";

  it("returns input unchanged when disabled", () => {
    expect(colorizeIndexerLogLine(sampleFail, false)).toBe(sampleFail);
  });

  it("adds ANSI escapes for prefixes and labels when enabled", () => {
    const out = colorizeIndexerLogLine(sampleFail, true);
    expect(out).toContain("\x1b[");
    expect(out).toContain("\x1b[0m");
    expect(out).toMatch(/\x1b\[31m\[job\] fail\x1b\[0m/);
    expect(out).toContain("\x1b[36mid=");
    expect(out).toContain("\x1b[33mtype=");
    expect(out).toContain("\x1b[35maddress=");
    expect(out).toContain("\x1b[34mcontinuation=");
    expect(out).toContain("\x1b[31merror=");
    expect(out).toContain("\x1b[96mreason=");
  });

  it("colors [cron] prefix at line start", () => {
    const out = colorizeIndexerLogLine("[cron] tick start", true);
    expect(out).toMatch(/^\x1b\[33m\[cron\]\x1b\[0m tick start$/);
  });

  it("colors [job] start before shorter [job] match", () => {
    const out = colorizeIndexerLogLine("[job] start id=1 type=poll_hacker_address", true);
    expect(out).toMatch(/^\x1b\[36m\[job\] start\x1b\[0m/);
  });

  it("colors attempts= on fail lines", () => {
    const out = colorizeIndexerLogLine(
      "[job] fail id=42 type=backfill_hacker_address attempts=3 error=boom",
      true,
    );
    expect(out).toContain("\x1b[95mattempts=");
  });

  it("colors duration= and queue= on done lines", () => {
    const out = colorizeIndexerLogLine("[job] done id=1 type=refresh_live_balance duration=1.2s queue=42", true);
    expect(out).toContain("\x1b[32mduration=");
    expect(out).toContain("\x1b[94mqueue=");
  });

  it("colors progress and cursor labels on job start lines", () => {
    const out = colorizeIndexerLogLine(
      "[job] start id=1 type=backfill_hacker_address attempts=0 pendingTxidsCount=25 processedIndex=18 chainCursor=abc123def456 pagesExhausted=false",
      true,
    );
    expect(out).toContain("\x1b[92mpendingTxidsCount=");
    expect(out).toContain("\x1b[93mprocessedIndex=");
    expect(out).toContain("\x1b[90mchainCursor=");
    expect(out).toContain("\x1b[34mpagesExhausted=");
  });
});
