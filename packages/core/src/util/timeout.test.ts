import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves when promise completes before deadline", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "test")).resolves.toBe(42);
  });

  it("rejects when promise exceeds deadline", async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 5000);
    });
    const result = withTimeout(slow, 1000, "slow op");
    const expectation = expect(result).rejects.toThrow("slow op timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    vi.useRealTimers();
  });

  it("propagates promise rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "test")).rejects.toThrow("boom");
  });
});
