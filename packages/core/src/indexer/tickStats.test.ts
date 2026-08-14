import { describe, expect, it } from "vitest";
import {
  formatCronScheduleDoneLine,
  formatCronTickDoneLine,
  formatJobRunStatsSuffix,
} from "./tickStats.js";
import { createSubrequestBudget } from "./subrequestBudget.js";

describe("formatCronScheduleDoneLine", () => {
  it("includes subrequest fields when budget is limited", () => {
    const budget = createSubrequestBudget(50);
    budget.consume(6);
    const line = formatCronScheduleDoneLine(
      {
        skipNonCritical: false,
        crawlEnqueued: 1,
        pollEnqueued: 0,
        maintTick: false,
        btc: "inline",
      },
      budget,
      6,
    );
    expect(line).toBe(
      "[cron] schedule done subreq=6/50 sched=6 skipNonCritical=false crawlEnq=1 pollEnq=0 maint=false btc=inline",
    );
  });

  it("omits subrequest fields when budget is unlimited", () => {
    const budget = createSubrequestBudget(0);
    const line = formatCronScheduleDoneLine(
      {
        skipNonCritical: true,
        crawlEnqueued: 0,
        pollEnqueued: 0,
        maintTick: true,
        btc: "fresh",
      },
      budget,
      0,
    );
    expect(line).toBe(
      "[cron] schedule done skipNonCritical=true crawlEnq=0 pollEnq=0 maint=true btc=fresh",
    );
  });
});

describe("formatCronTickDoneLine", () => {
  it("formats limited budget tick summary", () => {
    const line = formatCronTickDoneLine({
      processed: 1,
      elapsedMs: 5149,
      subreqUsed: 18,
      subreqLimit: 50,
      schedSubreq: 6,
      workSubreq: 12,
      subreqRem: 32,
      queue: 294,
      stop: "subreq",
    });
    expect(line).toBe(
      "[cron] tick done processed=1 ms=5149 subreq=18/50 sched=6 work=12 rem=32 stop=subreq queue=294",
    );
  });

  it("omits subrequest fields when unlimited", () => {
    const line = formatCronTickDoneLine({
      processed: 0,
      elapsedMs: 42,
      subreqUsed: 0,
      subreqLimit: 0,
      schedSubreq: 0,
      workSubreq: 0,
      subreqRem: 0,
      queue: 10,
      stop: "idle",
    });
    expect(line).toBe("[cron] tick done processed=0 ms=42 stop=idle queue=10");
  });
});

describe("formatJobRunStatsSuffix", () => {
  it("includes chunk continuation fields", () => {
    const suffix = formatJobRunStatsSuffix(
      {
        continued: true,
        traceEdgeIndex: 24,
        traceEdgeTotal: 48,
        edgesApplied: 8,
      },
      12,
    );
    expect(suffix).toBe(" workSubreq=12 continued=true traceEdge=24/48 edgesApplied=8");
  });
});
