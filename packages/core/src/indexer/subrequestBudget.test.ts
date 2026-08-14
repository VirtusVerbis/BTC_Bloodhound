import { describe, expect, it } from "vitest";
import {
  createJobSubrequestBudget,
  createSubrequestBudget,
  scheduleSubrequestReserve,
} from "./subrequestBudget.js";

describe("createSubrequestBudget", () => {
  it("allows unlimited when limit is 0", () => {
    const budget = createSubrequestBudget(0);
    budget.consume(100);
    expect(budget.exhausted()).toBe(false);
    expect(budget.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it("tracks consumption against cap", () => {
    const budget = createSubrequestBudget(50);
    expect(budget.canConsume(10)).toBe(true);
    budget.consume(10);
    expect(budget.remaining()).toBe(40);
    expect(budget.exhausted()).toBe(false);
    budget.consume(40);
    expect(budget.exhausted()).toBe(true);
    expect(budget.canConsume(1)).toBe(false);
  });
});

describe("createJobSubrequestBudget", () => {
  it("tracks per-job delta against tick budget", () => {
    const tick = createSubrequestBudget(50);
    tick.consume(5);
    const job = createJobSubrequestBudget(10, tick, 5);
    expect(job.unlimited()).toBe(false);
    expect(job.used()).toBe(0);
    tick.consume(4);
    expect(job.used()).toBe(4);
    expect(job.canUse(7)).toBe(false);
    expect(job.exhausted()).toBe(false);
    tick.consume(6);
    expect(job.exhausted()).toBe(true);
  });

  it("is unlimited when maxSubrequestsPerJob is 0", () => {
    const tick = createSubrequestBudget(50);
    const job = createJobSubrequestBudget(0, tick, 0);
    expect(job.unlimited()).toBe(true);
    tick.consume(100);
    expect(job.exhausted()).toBe(false);
  });
});

describe("scheduleSubrequestReserve", () => {
  it("adds maint extra on maintenance ticks", () => {
    expect(
      scheduleSubrequestReserve({
        scheduleSubrequestReserve: 38,
        scheduleReserveMaintExtra: 10,
        hackerMaintenanceEveryNCrons: 40,
        maintenanceCronCounter: 40,
      }),
    ).toBe(48);
    expect(
      scheduleSubrequestReserve({
        scheduleSubrequestReserve: 38,
        scheduleReserveMaintExtra: 10,
        hackerMaintenanceEveryNCrons: 40,
        maintenanceCronCounter: 39,
      }),
    ).toBe(38);
  });
});
