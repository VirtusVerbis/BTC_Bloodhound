import { describe, expect, it } from "vitest";
import {
  formatCronScheduleDoneLine,
  formatCronTickDoneLine,
  formatJobRunStatsSuffix,
  formatTickPlanLine,
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

  it("includes throttled flag when soft backpressure is active", () => {
    const budget = createSubrequestBudget(0);
    const line = formatCronScheduleDoneLine(
      {
        skipNonCritical: false,
        crawlEnqueued: 0,
        pollEnqueued: 0,
        maintTick: true,
        btc: "skip",
        throttled: true,
      },
      budget,
      0,
    );
    expect(line).toContain("throttled=true");
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

  it("includes order and jobsCap when provided", () => {
    const line = formatCronTickDoneLine({
      processed: 2,
      elapsedMs: 100,
      subreqUsed: 0,
      subreqLimit: 0,
      schedSubreq: 0,
      workSubreq: 0,
      subreqRem: 0,
      queue: 45,
      stop: "jobs_cap",
      order: "drain",
      jobsCap: 2,
    });
    expect(line).toBe(
      "[cron] tick done processed=2 ms=100 order=drain jobsCap=2 stop=jobs_cap queue=45",
    );
  });

  it("includes jobsCapReason when provided", () => {
    const line = formatCronTickDoneLine({
      processed: 1,
      elapsedMs: 100,
      subreqUsed: 0,
      subreqLimit: 0,
      schedSubreq: 0,
      workSubreq: 0,
      subreqRem: 0,
      queue: 45,
      stop: "pair_wait",
      jobsCap: 1,
      jobsCapReason: "heavy_head",
    });
    expect(line).toBe(
      "[cron] tick done processed=1 ms=100 jobsCap=1 jobsCapReason=heavy_head stop=pair_wait queue=45",
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

describe("formatTickPlanLine", () => {
  it("formats tick plan with head weight", () => {
    const line = formatTickPlanLine({
      jobsCap: 2,
      jobsCapReason: "pair_light",
      headWeight: "light",
      pairable: 3,
      queue: 100,
    });
    expect(line).toBe(
      "[cron] tick plan jobsCap=2 jobsCapReason=pair_light headWeight=light pairable=3 queue=100",
    );
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
