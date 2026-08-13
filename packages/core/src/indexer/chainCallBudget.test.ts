import { describe, expect, it } from "vitest";
import { createChainCallBudget } from "./chainCallBudget.js";

describe("createChainCallBudget", () => {
  it("allows unlimited calls when max is 0", () => {
    const budget = createChainCallBudget(0);
    expect(budget.canCall()).toBe(true);
    budget.consume();
    budget.consume();
    expect(budget.canCall()).toBe(true);
    expect(budget.exhausted()).toBe(false);
    expect(budget.processBatchLimit(5)).toBe(5);
  });

  it("limits to one call when max is 1", () => {
    const budget = createChainCallBudget(1);
    expect(budget.canCall()).toBe(true);
    budget.consume();
    expect(budget.canCall()).toBe(false);
    expect(budget.exhausted()).toBe(true);
    expect(budget.processBatchLimit(5)).toBe(0);
  });

  it("processBatchLimit reflects remaining budget", () => {
    const budget = createChainCallBudget(3);
    expect(budget.processBatchLimit(5)).toBe(3);
    budget.consume();
    expect(budget.processBatchLimit(5)).toBe(2);
  });
});
