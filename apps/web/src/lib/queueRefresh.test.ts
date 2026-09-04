import { describe, expect, it } from "vitest";
import { shouldRefetchQueueOnCompletion } from "./queueRefresh";

describe("shouldRefetchQueueOnCompletion", () => {
  it("returns false when next is missing", () => {
    expect(shouldRefetchQueueOnCompletion("2026-01-01T00:00:00.000Z", null)).toBe(false);
  });

  it("returns true on first completion watermark", () => {
    expect(shouldRefetchQueueOnCompletion(null, "2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("returns true when completion timestamp changes", () => {
    expect(
      shouldRefetchQueueOnCompletion(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:05.000Z",
      ),
    ).toBe(true);
  });

  it("returns false when completion timestamp unchanged", () => {
    expect(
      shouldRefetchQueueOnCompletion(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(false);
  });
});
