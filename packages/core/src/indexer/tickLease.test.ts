import { describe, expect, it, vi } from "vitest";
import { clearTickLeaseSafe } from "./tickLease.js";

describe("clearTickLeaseSafe", () => {
  it("does not throw when clearTickLease rejects", async () => {
    const store = {
      clearTickLease: vi.fn(async () => {
        throw new Error("lease clear failed");
      }),
    };
    await expect(clearTickLeaseSafe(store)).resolves.toBeUndefined();
  });

  it("calls onError with formatted message including cause", async () => {
    const onError = vi.fn();
    const store = {
      clearTickLease: vi.fn(async () => {
        throw new Error("Failed query: update scheduler_state", {
          cause: new Error("D1_ERROR: internal error; reference = v0dri"),
        });
      }),
    };
    await clearTickLeaseSafe(store, onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain("Failed query: update scheduler_state");
    expect(onError.mock.calls[0][0]).toContain("cause: D1_ERROR: internal error");
  });

  it("does not call onError on success", async () => {
    const onError = vi.fn();
    const store = { clearTickLease: vi.fn(async () => {}) };
    await clearTickLeaseSafe(store, onError);
    expect(onError).not.toHaveBeenCalled();
  });
});
