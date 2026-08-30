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

  it("colors cron tick and subrequest labels", () => {
    const out = colorizeIndexerLogLine(
      "[cron] tick done processed=1 ms=5149 subreq=18/50 sched=6 work=12 rem=32 stop=subreq queue=294",
      true,
    );
    expect(out).toMatch(/^\x1b\[38;5;117m\[cron\] tick done\x1b\[0m/);
    expect(out).toContain("\x1b[38;5;208msubreq=");
    expect(out).toContain("\x1b[38;5;141msched=");
    expect(out).toContain("\x1b[38;5;51mwork=");
    expect(out).toContain("\x1b[38;5;118mrem=");
    expect(out).toContain("\x1b[38;5;203mstop=");
    expect(out).toContain("\x1b[38;5;147mprocessed=");
    expect(out).toContain("\x1b[90mms=");
  });

  it("colors schedule done labels", () => {
    const out = colorizeIndexerLogLine(
      "[cron] schedule done subreq=6/50 sched=6 skipNonCritical=false crawlEnq=1 pollEnq=0 maint=false btc=inline",
      true,
    );
    expect(out).toMatch(/^\x1b\[38;5;214m\[cron\] schedule done\x1b\[0m/);
    expect(out).toContain("\x1b[38;5;220mskipNonCritical=");
    expect(out).toContain("\x1b[38;5;30mcrawlEnq=");
    expect(out).toContain("\x1b[38;5;39mpollEnq=");
    expect(out).toContain("\x1b[38;5;218mmaint=");
    expect(out).toContain("\x1b[38;5;229mbtc=");
  });

  it("colors progress and cursor labels on job start lines", () => {
    const out = colorizeIndexerLogLine(
      "[job] start id=1 type=backfill_hacker_address attempts=0 pendingTxidsCount=25 processedIndex=18 progress=18/25 chainCursor=abc123def456 pagesExhausted=false",
      true,
    );
    expect(out).toContain("\x1b[92mpendingTxidsCount=");
    expect(out).toContain("\x1b[93mprocessedIndex=");
    expect(out).toContain("\x1b[38;5;226mprogress=");
    expect(out).toContain("\x1b[90mchainCursor=");
    expect(out).toContain("\x1b[34mpagesExhausted=");
  });
});

describe("colorizeIndexerLogLine sidecar mode", () => {
  const sampleFail =
    "[job] fail id=42 type=backfill_hacker_address error=Provider pacing: next call allowed at 2026-08-13T05:51:05.846Z";

  it("returns input unchanged when disabled", () => {
    expect(colorizeIndexerLogLine(sampleFail, false, "sidecar")).toBe(sampleFail);
  });

  it("uses prod cron colors on [cron] and [job] lines", () => {
    const cronOut = colorizeIndexerLogLine("[cron] tick done processed=1 queue=310", true, "sidecar");
    expect(cronOut).toMatch(/^\x1b\[38;5;117m\[cron\] tick done\x1b\[0m/);
    expect(cronOut).toContain("\x1b[38;5;147mprocessed=");
    expect(cronOut).toContain("\x1b[94mqueue=");

    const jobOut = colorizeIndexerLogLine(
      "[job] start id=1 type=expand_downstream attempts=0 pendingTxidsCount=25 processedIndex=18 progress=18/25 phase=process",
      true,
      "sidecar",
    );
    expect(jobOut).toMatch(/^\x1b\[36m\[job\] start\x1b\[0m/);
    expect(jobOut).toContain("\x1b[92mpendingTxidsCount=");
    expect(jobOut).toContain("\x1b[93mprocessedIndex=");
    expect(jobOut).toContain("\x1b[38;5;226mprogress=");
    expect(jobOut).toContain("\x1b[38;5;141mphase=");
  });

  it("uses white prefix and colored key labels on [sidecar] heartbeat", () => {
    const out = colorizeIndexerLogLine(
      "[sidecar] heartbeat queue=310 pending=309 running=2 apiBackoff=none jobsSinceStart=60 elapsed=16m18s",
      true,
      "sidecar",
    );
    expect(out).toMatch(/\x1b\[97m\[sidecar\] heartbeat\x1b\[0m/);
    expect(out).toContain("\x1b[94mqueue=");
    expect(out).toContain("\x1b[38;5;208mapiBackoff=");
    expect(out).toContain("\x1b[38;5;147mjobsSinceStart=");
    expect(out).toContain("\x1b[90melapsed=");
  });

  it("uses red prefix and red error= on fail lines", () => {
    const out = colorizeIndexerLogLine(sampleFail, true, "sidecar");
    expect(out).toMatch(/\x1b\[31m\[job\] fail\x1b\[0m/);
    expect(out).toMatch(/\x1b\[31merror=/);
    expect(out).toContain("Provider pacing");
  });

  it("uses red prefix on defer and sidecar error lines", () => {
    const defer = "[job] defer id=1 type=expand_downstream attempts=3 deferSec=86400 run_after=2026-08-14T00:00:00.000Z";
    const sidecarErr = "[sidecar] error cron not paused";
    expect(colorizeIndexerLogLine(defer, true, "sidecar")).toMatch(/\x1b\[31m\[job\] defer\x1b\[0m/);
    expect(colorizeIndexerLogLine(sidecarErr, true, "sidecar")).toMatch(
      /\x1b\[31m\[sidecar\] error cron not paused\x1b\[0m/,
    );
  });
});
